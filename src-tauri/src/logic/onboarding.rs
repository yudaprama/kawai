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

        // ── Source: LinkedIn discovery (URL-only fallback — Apify is Phase 3) ──
        if let Some(search) = linkedin_search.take() {
            if signals.has_minimum_signals() {
                yield OnboardingEvent::SourceStarted { source: SOURCE_LINKEDIN.into() };
                // `discover` builds the privacy-preserving queries, runs the
                // injected search, and returns candidates ranked by
                // confidence (highest first); empty = nothing plausible.
                let candidates = discover(&signals, &search).await;
                if candidates.is_empty() {
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_LINKEDIN.into(),
                        note: "no plausible profile found".into(),
                    };
                } else {
                    yield OnboardingEvent::SourceProgress {
                        source: SOURCE_LINKEDIN.into(),
                        note: format!("found {} profile candidate(s)", candidates.len()),
                    };
                    let top = &candidates[0];
                    if top.confidence >= CONFIDENCE_HIGH {
                        // High confidence ⇒ the URL is treated as the user's
                        // own profile. Auto-scrape via the vault-keyed Apify
                        // token (skipped silently when the vault has none);
                        // otherwise URL-only hint.
                        if apify::Apify::is_configured() {
                            yield OnboardingEvent::SourceProgress {
                                source: SOURCE_LINKEDIN.into(),
                                note: format!("scraping {} via Apify", top.url),
                            };
                            match scrape_linkedin(&top.url).await {
                                Ok(md) if !md.trim().is_empty() => {
                                    linkedin_materials.push_str(&md);
                                }
                                Ok(_) => {
                                    yield OnboardingEvent::SourceProgress {
                                        source: SOURCE_LINKEDIN.into(),
                                        note: "scrape returned an empty profile — URL-only fallback".into(),
                                    };
                                    materials.push_str(&format!(
                                        "LinkedIn profile: {} ({})\n\n",
                                        top.url, top.title
                                    ));
                                }
                                Err(e) => {
                                    yield OnboardingEvent::SourceProgress {
                                        source: SOURCE_LINKEDIN.into(),
                                        note: format!("scrape failed ({e}) — URL-only fallback"),
                                    };
                                    materials.push_str(&format!(
                                        "LinkedIn profile: {} ({})\n\n",
                                        top.url, top.title
                                    ));
                                }
                            }
                        } else {
                            materials.push_str(&format!(
                                "LinkedIn profile: {} ({})\n\n",
                                top.url, top.title
                            ));
                        }
                    } else {
                        // Low confidence: still a hint, flagged as unverified.
                        // Never scraped regardless of consent.
                        materials.push_str(&format!(
                            "Possible LinkedIn profile (unverified): {}\n\n",
                            top.url
                        ));
                    }
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
                yield OnboardingEvent::SourceCompleted { source: SOURCE_LINKEDIN.into(), items_found: linkedin_items };
            }
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
