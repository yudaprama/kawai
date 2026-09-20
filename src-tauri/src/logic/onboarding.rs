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
                        materials.push_str(&format!(
                            "LinkedIn profile: {} ({})\n\n",
                            top.url, top.title
                        ));
                    } else {
                        // Low confidence: still a hint, flagged as unverified.
                        materials.push_str(&format!(
                            "Possible LinkedIn profile (unverified): {}\n\n",
                            top.url
                        ));
                    }
                }
                processed.push(SOURCE_LINKEDIN.into());
                yield OnboardingEvent::SourceCompleted { source: SOURCE_LINKEDIN.into(), items_found: 0 };
            }
        }

        // ── Compress + persist ──
        if materials.trim().is_empty() {
            // Zero usable sources: still completes (never blocks chat).
            let conn = match db_connection(&user_id).await {
                Ok(c) => c,
                Err(e) => {
                    yield OnboardingEvent::OnboardingError { message: e.to_string() };
                    return;
                }
            };
            kv_set(&conn, KV_COMPLETED, "true").await;
            kv_set(&conn, KV_SOURCES, &serde_json::to_string(&processed).unwrap_or_default()).await;
            yield OnboardingEvent::OnboardingFinished { total_items: 0 };
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

        // Persist: dedup against existing titles (case-insensitive), store
        // with source='questions' provenance (external provenance upgrades —
        // linkedin/document — land in Phase 3).
        let mut stored = 0u32;
        match persist_compressed(&user_id, &compressed).await {
            Ok(n) => stored = n,
            Err(e) => {
                yield OnboardingEvent::OnboardingError { message: format!("persistence failed: {e}") };
                return;
            }
        }

        yield OnboardingEvent::ProfileReady { profile: counts.0, people: counts.1, goals: counts.2 };
        let conn = match db_connection(&user_id).await {
            Ok(c) => c,
            Err(e) => {
                yield OnboardingEvent::OnboardingError { message: e.to_string() };
                return;
            }
        };
        kv_set(&conn, KV_COMPLETED, "true").await;
        kv_set(&conn, KV_SOURCES, &serde_json::to_string(&processed).unwrap_or_default()).await;
        yield OnboardingEvent::OnboardingFinished { total_items: stored };
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
async fn persist_compressed(
    user_id: &str,
    compressed: &onboarding::compress::CompressedProfile,
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
        if kawai_memory::memory_create_ns(
            user_id,
            "fact",
            &item.title,
            &item.content,
            &item.namespace,
            false,
            "questions",
        )
        .await
        .is_ok()
        {
            stored += 1;
        }
    }
    Ok(stored)
}
