//! Onboarding context-gathering (PLAN-personal-context §2.3): post-auth
//! opt-in pipeline that turns quick questions + public identity sources into
//! profile memories, so the agent knows the user before the first goal.
//! Pure orchestration lives in the `onboarding` crate; this module owns
//! state persistence (kv), the LLM compression call, and persistence into
//! the `memories` table via `kawai_memory::memory_create_ns`.

use futures_util::Stream;
use kawai_events::OnboardingEvent;
use onboarding::compress::{
    compress_system_prompt, compress_task, parse_compressed, CompressedItem,
};
use onboarding::github;
use onboarding::linkedin::{discover, CONFIDENCE_HIGH};
use onboarding::IdentitySignals;
use serde::{Deserialize, Serialize};

use kawai_db::{db_connection, unix_now, DbError};

/// Sources recorded in `onboarding_state` once processed.
pub const SOURCE_QUESTIONS: &str = "questions";
pub const SOURCE_GITHUB: &str = "github";
pub const SOURCE_LINKEDIN: &str = "linkedin";
pub const SOURCE_DOCUMENT: &str = "document";
pub const SOURCE_GMAIL: &str = "gmail";

/// Head chars of extracted document text fed to the compressor (compress
/// tail-keeps again, so this bounds the read without losing the tail).
const DOCUMENT_MATERIALS_CHARS: usize = 24_000;

/// The Apify actor behind the opt-in LinkedIn enrichment (plan §2.5 — the
/// scrape and its ToS exposure live on Apify's platform). Token comes from
/// the kawai vault (`kawai_constants::apify`); no env var, no user key.
pub const LINKEDIN_ACTOR: &str = "dev_fusion~linkedin-profile-scraper";

const KV_COMPLETED: &str = "completed";
const KV_SOURCES: &str = "sources";

/// Answers to the quick questions, as supplied by the UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAnswer {
    pub question: String,
    pub answer: String,
}

/// What the user opted into for this run.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSources {
    #[serde(default)]
    pub questions: Vec<QuickAnswer>,
    /// Optional public GitHub username — identity discovery seed.
    #[serde(default)]
    pub github_username: Option<String>,
    /// Opt-in Gmail scan (read-only, metadata + ≤10 `from:linkedin.com`
    /// bodies for self-URL extraction — bodies are never persisted). Only
    /// runs when a Composio Gmail connection already exists.
    #[serde(default)]
    pub gmail: bool,
}

/// Current onboarding state, read back by the UI gate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStatus {
    pub completed: bool,
    pub sources: Vec<String>,
}

// ── kv state ────────────────────────────────────────────────────────────────

async fn kv_get(conn: &libsql::Connection, key: &str) -> Option<String> {
    let mut rows = conn
        .query(
            "SELECT value FROM onboarding_state WHERE key = ?",
            vec![key],
        )
        .await
        .ok()?;
    rows.next().await.ok()?.and_then(|r| r.get(0).ok())
}

async fn kv_set(conn: &libsql::Connection, key: &str, value: &str) {
    let _ = conn
        .execute(
            "INSERT INTO onboarding_state (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, value, unix_now() as i64),
        )
        .await;
}

/// Read the onboarding state. Failure degrades to "not completed" (the UI
/// gate shows the opt-in step again — never a hard error).
pub async fn onboarding_status(user_id: &str) -> Result<OnboardingStatus, DbError> {
    let conn = db_connection(user_id).await?;
    let completed = kv_get(&conn, KV_COMPLETED)
        .await
        .map(|v| v == "true")
        .unwrap_or(false);
    let sources = kv_get(&conn, KV_SOURCES)
        .await
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_default();
    Ok(OnboardingStatus { completed, sources })
}

/// Mark onboarding done with zero sources — the user is never blocked from
/// chat, and the gate never re-prompts after a skip.
pub async fn onboarding_skip(user_id: &str) -> Result<(), DbError> {
    let conn = db_connection(user_id).await?;
    kv_set(&conn, KV_COMPLETED, "true").await;
    kv_set(&conn, KV_SOURCES, "[]").await;
    Ok(())
}

/// Clear state + all profile-namespace memories (dev / re-run).
pub async fn onboarding_reset(user_id: &str) -> Result<usize, DbError> {
    let conn = db_connection(user_id).await?;
    let profile_ids: Vec<String> = {
        let mut rows = conn
            .query(
                "SELECT id FROM memories WHERE namespace = 'profile'",
                (),
            )
            .await?;
        let mut ids = Vec::new();
        while let Some(row) = rows.next().await? {
            ids.push(row.get(0)?);
        }
        ids
    };
    let n = profile_ids.len();
    for id in profile_ids {
        // Full delete path purges embeddings + FTS + entities.
        let _ = kawai_memory::memory_delete(user_id, &id).await;
    }
    let _ = conn
        .execute("DELETE FROM onboarding_state", ())
        .await;
    let _ = conn
        .execute("DELETE FROM profile_facets", ())
        .await;
    Ok(n)
}

// ── the run stream ──────────────────────────────────────────────────────────

/// Run the context-gathering pipeline, streaming [`OnboardingEvent`]s.
/// Every stage is best-effort: a failing source reports progress + completes
/// with zero items and the run continues; only a total failure (no usable
/// sources AND a compression error) terminates with `OnboardingError`.
pub fn onboarding_run_stream(
    user_id: String,
    sources: OnboardingSources,
) -> impl Stream<Item = OnboardingEvent> + Send {
    async_stream::stream! {
        let mut materials = String::new();
        // Scraped-profile materials (opt-in Apify) compress separately so
        // their memories carry source='linkedin' provenance.
        let mut linkedin_materials = String::new();
        let mut linkedin_items: u32 = 0;
        let mut signals = IdentitySignals::default();
        let mut processed: Vec<String> = Vec::new();
        let mut linkedin_search: Option<onboarding::SearchFn> =
            onboarding::adapter::webread_search_fn(&user_id);

        // ── Source: quick questions ──
        if !sources.questions.is_empty() {
            yield OnboardingEvent::SourceStarted { source: SOURCE_QUESTIONS.into() };
            for qa in &sources.questions {
                let q = qa.question.trim();
                let a = qa.answer.trim();
                if q.is_empty() || a.is_empty() {
                    continue;
                }
                materials.push_str(&format!("Q: {q}\nA: {a}\n\n"));
                // Role/focus answers double as identity signals for discovery.
                let ql = q.to_lowercase();
                if ql.contains("name") && signals.full_name.is_none() {
                    signals.full_name = Some(a.to_string());
                } else if (ql.contains("role") || ql.contains("work")) && signals.role.is_none() {
                    signals.role = Some(a.to_string());
                }
            }
            processed.push(SOURCE_QUESTIONS.into());
            yield OnboardingEvent::SourceCompleted { source: SOURCE_QUESTIONS.into(), items_found: 0 };
        }

        // ── Source: GitHub identity ──
        if let Some(username) = sources.github_username.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            yield OnboardingEvent::SourceStarted { source: SOURCE_GITHUB.into() };
            signals.github_username = Some(username.to_string());
            match github::fetch_identity(username, &reqwest::Client::new(), github::DEFAULT_GITHUB_BASE).await {
                Ok(profile) => {
                    let mut note_parts = Vec::new();
                    if let Some(name) = &profile.name { note_parts.push(format!("name: {name}")); }
                    if let Some(company) = &profile.company { note_parts.push(format!("company: {company}")); }
                    if let Some(bio) = &profile.bio { if !bio.is_empty() { materials.push_str(&format!("GitHub bio: {bio}\n\n")); note_parts.push("bio".into()); } }
                    signals = IdentitySignals::from(&profile).role_merged(signals.role.clone());
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_GITHUB.into(),
                        note: note_parts.join(", "),
                    };
                }
                Err(e) => {
                    yield OnboardingEvent::SourceProgress { source: SOURCE_GITHUB.into(), note: format!("profile fetch failed: {e}") };
                }
            }
            processed.push(SOURCE_GITHUB.into());
            yield OnboardingEvent::SourceCompleted { source: SOURCE_GITHUB.into(), items_found: 0 };
        }

        // ── Source: Gmail self-URL extraction (opt-in, Composio read-only) ──
        // The openhuman trick: notification emails from LinkedIn always
        // reference the RECIPIENT's own profile, so `from:linkedin.com`
        // bodies reliably yield the self URL. Priority 1:
        // `linkedin.com/comm/in/<user>`; priority 2: `linkedin.com/in/<user>`.
        // Bodies and all other matches are discarded in-memory, never
        // persisted. Only runs when a Composio Gmail connection exists.
        let mut gmail_linkedin_url: Option<String> = None;
        if sources.gmail {
            yield OnboardingEvent::SourceStarted { source: SOURCE_GMAIL.into() };
            match gmail_self_url().await {
                Ok(Some(url)) => {
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_GMAIL.into(),
                        note: "found self LinkedIn URL in Gmail notifications".into(),
                    };
                    gmail_linkedin_url = Some(url);
                }
                Ok(None) => {
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_GMAIL.into(),
                        note: "no LinkedIn self URL in recent notifications".into(),
                    };
                }
                Err(e) => {
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_GMAIL.into(),
                        note: format!("gmail unavailable: {e} — connect via composio_authorize"),
                    };
                }
            }
            processed.push(SOURCE_GMAIL.into());
            yield OnboardingEvent::SourceCompleted {
                source: SOURCE_GMAIL.into(),
                items_found: gmail_linkedin_url.is_some() as u32,
            };
        }

        // ── Source: LinkedIn (Gmail self URL > discovery; URL-only fallback; auto-scrape) ──
        // Resolve the profile URL: a Gmail-extracted self URL wins outright;
        // otherwise fall back to web-search discovery over identity signals.
        let mut linkedin_target: Option<(String, String)> = None; // (url, title)
        let mut linkedin_high_confidence = false;
        if let Some(url) = gmail_linkedin_url.clone() {
            linkedin_target = Some((url, "self URL from Gmail notifications".into()));
            linkedin_high_confidence = true;
        } else if let Some(search) = linkedin_search.take() {
            if signals.has_minimum_signals() {
                yield OnboardingEvent::SourceStarted { source: SOURCE_LINKEDIN.into() };
                // `discover` builds the privacy-preserving queries, runs the
                // injected search, and returns candidates ranked by
                // confidence (highest first); empty = nothing plausible.
                let candidates = discover(&signals, &search).await;
                match candidates.first() {
                    None => {
                        yield OnboardingEvent::SourceProgress {
                            source: SOURCE_LINKEDIN.into(),
                            note: "no plausible profile found".into(),
                        };
                    }
                    Some(top) => {
                        yield OnboardingEvent::SourceProgress {
                            source: SOURCE_LINKEDIN.into(),
                            note: format!("found {} profile candidate(s)", candidates.len()),
                        };
                        linkedin_high_confidence = top.confidence >= CONFIDENCE_HIGH;
                        linkedin_target = Some((top.url.clone(), top.title.clone()));
                    }
                }
            }
        }

        if let Some((url, title)) = linkedin_target {
            yield OnboardingEvent::SourceStarted { source: SOURCE_LINKEDIN.into() };
            if linkedin_high_confidence {
                // High confidence ⇒ the URL is treated as the user's own
                // profile. Auto-scrape via the vault-keyed Apify token
                // (skipped silently when the vault has none); otherwise
                // URL-only hint.
                if apify::Apify::is_configured() {
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_LINKEDIN.into(),
                        note: format!("scraping {url} via Apify"),
                    };
                    match scrape_linkedin(&url).await {
                        Ok(md) if !md.trim().is_empty() => {
                            linkedin_materials.push_str(&md);
                        }
                        Ok(_) => {
                            yield OnboardingEvent::SourceProgress {
                                source: SOURCE_LINKEDIN.into(),
                                note: "scrape returned an empty profile — URL-only fallback".into(),
                            };
                            materials.push_str(&format!("LinkedIn profile: {url} ({title})\n\n"));
                        }
                        Err(e) => {
                            yield OnboardingEvent::SourceProgress {
                                source: SOURCE_LINKEDIN.into(),
                                note: format!("scrape failed ({e}) — URL-only fallback"),
                            };
                            materials.push_str(&format!("LinkedIn profile: {url} ({title})\n\n"));
                        }
                    }
                } else {
                    materials.push_str(&format!("LinkedIn profile: {url} ({title})\n\n"));
                }
            } else {
                // Low confidence: still a hint, flagged as unverified. Never scraped.
                materials.push_str(&format!("Possible LinkedIn profile (unverified): {url}\n\n"));
            }
            processed.push(SOURCE_LINKEDIN.into());

            // LinkedIn materials compress separately so provenance is
            // honest: these items land with source='linkedin' and keep
            // their `profile` namespace (facet distill folds them).
            if !linkedin_materials.trim().is_empty() {
                yield OnboardingEvent::CompressStarted;
                match compress_with_cloud(&linkedin_materials).await {
                    Ok(compressed) => {
                        let counts = (
                            compressed.profile.len() as u32,
                            compressed.people.len() as u32,
                            compressed.goals.len() as u32,
                        );
                        match persist_compressed(&user_id, &compressed, "linkedin", false).await {
                            Ok(n) => linkedin_items = n,
                            Err(e) => {
                                yield OnboardingEvent::SourceProgress {
                                    source: SOURCE_LINKEDIN.into(),
                                    note: format!("persistence failed: {e}"),
                                };
                            }
                        }
                        yield OnboardingEvent::ProfileReady {
                            profile: counts.0,
                            people: counts.1,
                            goals: counts.2,
                        };
                    }
                    Err(e) => {
                        yield OnboardingEvent::SourceProgress {
                            source: SOURCE_LINKEDIN.into(),
                            note: format!("compression failed: {e}"),
                        };
                    }
                }
            }
            yield OnboardingEvent::SourceCompleted {
                source: SOURCE_LINKEDIN.into(),
                items_found: linkedin_items,
            };
        }


        // ── Compress + persist the local-sources materials ──
        if materials.trim().is_empty() {
            // Zero usable sources: still completes (never blocks chat).
            mark_done(&user_id, &processed).await;
            yield OnboardingEvent::OnboardingFinished { total_items: linkedin_items };
            return;
        }

        yield OnboardingEvent::CompressStarted;
        let compressed = match compress_with_cloud(&materials).await {
            Ok(c) => c,
            Err(e) => {
                yield OnboardingEvent::OnboardingError {
                    message: format!("compression failed: {e}"),
                };
                return;
            }
        };
        let counts = (
            compressed.profile.len() as u32,
            compressed.people.len() as u32,
            compressed.goals.len() as u32,
        );

        let mut stored = 0u32;
        match persist_compressed(&user_id, &compressed, "questions", true).await {
            Ok(n) => stored = n,
            Err(e) => {
                yield OnboardingEvent::OnboardingError { message: format!("persistence failed: {e}") };
                return;
            }
        }

        yield OnboardingEvent::ProfileReady { profile: counts.0, people: counts.1, goals: counts.2 };
        // Facet distill rides the onboarding persist (best-effort — a
        // vault-less run just skips; the profile facts still live as
        // general-namespace memories and inject normally).
        if let Err(e) = kawai_memory::facet_distill(&user_id).await {
            eprintln!("[onboarding] facet distill skipped: {e}");
        }
        mark_done(&user_id, &processed).await;
        yield OnboardingEvent::OnboardingFinished { total_items: stored + linkedin_items };
    }
}

/// Run the consented Apify LinkedIn-profile actor and render the result to
/// markdown for the compressor. Token resolves from the kawai vault inside
/// the client (`is_configured` was checked by the caller).
async fn scrape_linkedin(profile_url: &str) -> Result<String, String> {
    let client = apify::Apify::new().map_err(|e| e.to_string())?;
    let items = client
        .run_sync(&apify::RunRequest::new(
            LINKEDIN_ACTOR,
            serde_json::json!({ "profileUrls": [profile_url] }),
        ))
        .await
        .map_err(|e| e.to_string())?;
    let Some(first) = items.first() else {
        return Ok(String::new());
    };
    let p = apify::linkedin::Profile::from_item(first);
    let mut md = String::new();
    if let Some(name) = &p.full_name {
        md.push_str(&format!("LinkedIn name: {name}\n"));
    }
    if let Some(headline) = &p.headline {
        md.push_str(&format!("LinkedIn headline: {headline}\n"));
    }
    if let Some(company) = &p.company {
        md.push_str(&format!("LinkedIn company: {company}\n"));
    }
    if let Some(location) = &p.location {
        md.push_str(&format!("LinkedIn location: {location}\n"));
    }
    if !p.skills.is_empty() {
        md.push_str(&format!("LinkedIn skills: {}\n", p.skills.join(", ")));
    }
    if let Some(summary) = &p.summary {
        md.push_str(&format!("LinkedIn summary: {summary}\n"));
    }
    Ok(md)
}

/// Import one uploaded document (LinkedIn data export / resume / bio) as an
/// onboarding source (plan §2.5 path 1, the zero-dependency default):
/// ragloader extracts text from the already-imported store file → one cloud
/// compression pass → persist with `source='document'` provenance (external
/// source: `profile`-namespace items are kept for the facet distill) →
/// best-effort facet distill → the source is recorded in onboarding state.
/// Returns the number of memories stored.
pub async fn onboarding_import_document(user_id: &str, file_id: &str) -> Result<u32, DbError> {
    let path = kawai_office::store::file_path(user_id, file_id).map_err(DbError::Config)?;
    let chunks = ragloader::load_file(&path, &ragloader::LoadOptions::default())
        .await
        .map_err(|e| DbError::Config(format!("document extract failed: {e}")))?;
    let mut materials = String::new();
    for c in &chunks {
        materials.push_str(&c.content);
        materials.push('\n');
        if materials.chars().count() >= DOCUMENT_MATERIALS_CHARS {
            break;
        }
    }
    if materials.trim().is_empty() {
        return Err(DbError::Config("document contained no extractable text".into()));
    }

    let compressed = compress_with_cloud(&materials)
        .await
        .map_err(DbError::Config)?;
    let stored = persist_compressed(user_id, &compressed, SOURCE_DOCUMENT, false).await?;

    if let Err(e) = kawai_memory::facet_distill(user_id).await {
        eprintln!("[onboarding] facet distill skipped: {e}");
    }

    // Record the source in onboarding state (append if not present).
    let conn = db_connection(user_id).await?;
    let mut sources: Vec<String> = kv_get(&conn, KV_SOURCES)
        .await
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    if !sources.iter().any(|s| s == SOURCE_DOCUMENT) {
        sources.push(SOURCE_DOCUMENT.into());
        kv_set(&conn, KV_SOURCES, &serde_json::to_string(&sources).unwrap_or_default()).await;
    }
    Ok(stored)
}

/// Scan recent `from:linkedin.com` notifications via the Composio Gmail
/// connection and extract the recipient's own profile URL (priority 1:
/// `linkedin.com/comm/in/<user>` — notification emails always reference the
/// recipient; priority 2: `linkedin.com/in/<user>`). Read-only: only the URL
/// survives — message bodies and all other matches are discarded in-memory.
/// `Ok(None)` = connected but nothing found; `Err` = no vault key / no
/// active Gmail connection / fetch failure (all best-effort skip reasons).
async fn gmail_self_url() -> Result<Option<String>, String> {
    let api_key = kawai_constants::composio::get_composio_api_key();
    if api_key.trim().is_empty() {
        return Err("no Composio key".into());
    }
    let client = composio::ComposioClient::new(api_key);
    let accounts = client
        .list_connected_accounts()
        .await
        .map_err(|e| format!("list connections: {e}"))?;
    let account = accounts
        .items
        .iter()
        .find(|a| a.toolkit.eq_ignore_ascii_case("gmail") && a.status.eq_ignore_ascii_case("ACTIVE"))
        .ok_or_else(|| "no active Gmail connection".to_string())?;

    let resp = client
        .execute_tool(
            "GMAIL_FETCH_EMAILS",
            serde_json::json!({ "query": "from:linkedin.com", "maxResults": 10 }),
            Some(account.id.clone()),
        )
        .await
        .map_err(|e| format!("fetch emails: {e}"))?;
    if !resp.successful {
        return Err(resp.error.unwrap_or_else(|| "gmail fetch failed".into()));
    }

    // Defensive shape handling: Composio action output shapes vary — search
    // the serialized payload for the URL patterns instead of walking it.
    let payload = resp.data.to_string();
    Ok(extract_self_linkedin_url(&payload))
}

/// Two-priority self-URL extraction over arbitrary Gmail payload text.
fn extract_self_linkedin_url(text: &str) -> Option<String> {
    for pattern in ["linkedin.com/comm/in/", "linkedin.com/in/"] {
        let mut search_from = 0usize;
        while let Some(idx) = text[search_from..].find(pattern) {
            let start = search_from + idx + pattern.len();
            let slug: String = text[start..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            // A real profile slug is at least 3 chars — this also skips
            // template placeholders like `/in/` with nothing after it.
            if slug.chars().count() >= 3 {
                if let Some(canonical) = apify::linkedin::ProfileUrl::parse(&format!(
                    "https://www.{pattern}{slug}"
                )) {
                    return Some(canonical.as_str().to_string());
                }
            }
            search_from = start;
        }
    }
    None
}

/// Mark onboarding done with the processed source list.
async fn mark_done(user_id: &str, processed: &[String]) {
    match db_connection(user_id).await {
        Ok(conn) => {
            kv_set(&conn, KV_COMPLETED, "true").await;
            kv_set(
                &conn,
                KV_SOURCES,
                &serde_json::to_string(processed).unwrap_or_default(),
            )
            .await;
        }
        Err(e) => eprintln!("[onboarding] state write failed: {e}"),
    }
}

/// Merge role info that the GitHub profile can't carry.
trait RoleMerged {
    fn role_merged(self, role: Option<String>) -> Self;
}
impl RoleMerged for IdentitySignals {
    fn role_merged(mut self, role: Option<String>) -> Self {
        if self.role.is_none() {
            self.role = role;
        }
        self
    }
}

/// One cloud one-shot over the materials. Errors when no provider is
/// configured or the answer is malformed.
async fn compress_with_cloud(materials: &str) -> Result<onboarding::compress::CompressedProfile, String> {
    let answer = remote_llm::reason::reason_in(
        compress_system_prompt(),
        &compress_task(materials),
        "onboarding-compressor",
        None,
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    parse_compressed(&answer)
}

/// Store compressed items as memories (dedup by title, case-insensitive).
/// Returns how many rows landed.
///
/// `source` is the provenance written on every row. Namespace mapping: for
/// LOCAL sources (`questions`) `profile`-namespace items are stored as
/// `general` so they inject into agent prompts immediately; EXTERNAL
/// sources (linkedin/documents) keep `profile` — those rows are the facet
/// distill's input and inject via the `<profile>` block. `people`/`goals`
/// inject in either namespace.
async fn persist_compressed(
    user_id: &str,
    compressed: &onboarding::compress::CompressedProfile,
    source: &str,
    local_source: bool,
) -> Result<u32, DbError> {
    let existing = kawai_memory::memory_list(user_id).await?;
    let mut seen: Vec<String> = existing.iter().map(|m| m.title.to_lowercase()).collect();
    let all: Vec<&CompressedItem> = compressed
        .profile
        .iter()
        .chain(compressed.people.iter())
        .chain(compressed.goals.iter())
        .collect();
    let mut stored = 0u32;
    for item in all {
        let key = item.title.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let namespace = if local_source && item.namespace == "profile" {
            "general"
        } else {
            item.namespace.as_str()
        };
        if kawai_memory::memory_create_ns(
            user_id,
            "fact",
            &item.title,
            &item.content,
            namespace,
            false,
            source,
        )
        .await
        .is_ok()
        {
            stored += 1;
        }
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::extract_self_linkedin_url;

    #[test]
    fn priority_comm_url_wins() {
        let body = r#"{"items":[{"body":"check https://www.linkedin.com/in/someone-else and
            your profile https://www.linkedin.com/comm/in/yuda-prama"}]}"#;
        let url = extract_self_linkedin_url(body).unwrap();
        // The /comm/in/ notification form canonicalizes to /in/<slug>.
        assert!(url.ends_with("/in/yuda-prama"), "got {url}");
    }

    #[test]
    fn falls_back_to_plain_in_url() {
        let body = r#"{"messages":[{"snippet":"see linkedin.com/in/budi-santoso today"}]}"#;
        let url = extract_self_linkedin_url(body).unwrap();
        assert!(url.ends_with("/in/budi-santoso"), "got {url}");
    }

    #[test]
    fn empty_slug_and_garbage_are_skipped() {
        assert!(extract_self_linkedin_url(r#"{"a":"linkedin.com/in/"}"#).is_none());
        assert!(extract_self_linkedin_url("no urls here at all").is_none());
    }
}
