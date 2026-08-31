# Implementation Plan — Personal context: "knows you in minutes"

Status: **IN PROGRESS** — the standalone Apify client and identity-discovery
foundation are implemented; transport wiring, Gmail/Composio ingestion,
consent UI, memory persistence, and onboarding orchestration remain. Inspired
by openhuman's onboarding/memory stack (Gmail/LinkedIn scan → LLM compress →
PROFILE.md → 18 memory families → experience store → facet cache), re-scoped
to kawai's architecture: per-user SQLite, pure `crates/`, dual wrappers,
prompt-block injection. The claim we are implementing: **after a 1–2 minute
opt-in flow, the agent already knows what the user cares about and has useful
identity context — before the user types anything.**

Non-goals up front:

- **kawai never scrapes LinkedIn itself.** The openhuman mechanism — Apify
  actor `dev_fusion/linkedin-profile-scraper` — is ported as an **opt-in,
  API-key-gated path** (§2.5): the scrape and its ToS exposure live on
  Apify's platform, behind an explicit consent dialog. The zero-dependency
  default remains a user-uploaded LinkedIn **data export** (HTML/CSV/PDF zip
  → ragloader) and/or structured quick-questions.
- **No raw email content is ever persisted.** Gmail is read-only scope,
  scanned in-memory, compressed to memory items, discarded.
- **No background scheduler in v1.** Re-learning is user-triggered
  (onboarding re-run / "update profile" button). A `tokio::time::interval`
  loop is a later phase once sources stabilize.

---

## 1. Current-state map — what we build on

OpenHuman concept | Kawai equivalent today | Delta
---|---|---
`memory_learn_all` → tree summarizer | `memory_extract` (`crates/foundation/memory/src/lib.rs:223`) — transcript → LLM → JSON candidates → dedup → `memories` table | Same pipeline shape; needs **external input sources**, not just chat transcripts
`ProfileMdRenderer` → PROFILE.md managed blocks | `memory::prompt_block()` (800c/4k/24 items) + `skills::prompt_block()` injected into the persona at opener build | Same injection model; needs **facets** (classified, stable, pinnable) as a third block
MemoryGuard 18 capability families | 5 `MEMORY_KINDS` (preference/rule/event/fact/goal), one flat table | Needs **namespaces** column + per-family prompt visibility
AgentExperience store | TurnMemory (`session_artifacts` table) logs process outputs, survives restarts | Needs a **distilled experience row** (task → lesson → tool sequence) written at plan completion
FacetCache (class/key/stability/user_state) | — | New table + new prompt block + rebuild path
Onboarding ContextGatheringStep | `auth-gate.tsx` → `use-auth.ts` (Supabase + deep-link PKCE pattern) | New post-auth **context gathering step** reusing the deep-link OAuth pattern for Google

Key existing infrastructure we reuse as-is:

- `remote_llm::RemoteLlm::from_env()` — the compression/extraction LLM tier
  (same vault as `memory_extract`; empty vault ⇒ features degrade gracefully).
- `ragloader` — parses the LinkedIn export (HTML/CSV/PDF) and any uploaded
  resume/bio document.
- `keychain.rs` + `kawai://auth` deep-link (PKCE) — reused for Google OAuth
  (`kawai://gmail` callback).
- Migration runner (`logic/db_migrations.rs`) — next numbers are
  `0010`/`0011`/`0012`.
- Event pipeline: `#[serde(tag = "type")]` in `crates/foundation/events` →
  `bun run generate:events` → TS matcher in the new hook.

**OpenHuman reference flow** (what Phases 2–3 re-scope — kept here so
implementers don't have to reverse-engineer it): Composio OAuth connects
Gmail → `GMAIL_FETCH_EMAILS { query: "from:linkedin.com", max_results: 10 }`
→ regex over message bodies with two priorities — `linkedin.com/comm/in/<user>`
first (notification emails always reference the *recipient's own* profile,
so this reliably yields the self URL), then `linkedin.com/in/<user>` →
Apify actor sync run (120 s timeout) returns profile JSON →
`render_profile_markdown` → LLM compress → `PROFILE.md` + memory write
tainted `ExternalSync` with source/url/actor provenance. **No Gmail
connection ⇒ every stage skips**; onboarding continues straight to chat.

---

## 2. Design

### 2.1 Memory namespaces (families) — Phase 1

One column, no second table. The 18 OpenHuman families collapse to the 5 that
map onto kawai's product surface:

```
namespace ∈ { profile, people, goals, episodic, general }   (default: general)
```

- `profile` — who the user is (role, employer, interests, style). Feeds the
  future facet block (§2.4).
- `people` — who the user knows (name → relationship/context one-liners).
- `goals` — standing objectives.
- `episodic` — durable events ("started at X on …").
- `general` — everything memory_extract produces today (kind stays
  preference/rule/event/fact/goal; namespace is orthogonal to kind).

`memories` schema addition (migration `0010_memory_namespaces.sql`):

```sql
ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT 'general';
ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX idx_memories_namespace ON memories(namespace);
```

- `memory_create` gains optional `namespace` + `pinned` + `source` params
  (both wrappers; camelCase maps 1:1). `source` is provenance — `chat` |
  `gmail` | `linkedin` | `document` | `questions` — surfaced in the Memory
  UI ("learned from Gmail") and used by facet distill to down-weight
  unconfirmed external data (a minimal port of openhuman's `ExternalSync`
  taint).
- `memory::prompt_block()` filters: injects `general` + `goals` + `people` +
  `episodic`; **`profile` rows are excluded** (they become facets in §2.4 —
  avoids double-injection). Pinned rows sort first and ignore the newest-first
  cutoff.
- `memory_extract` prompt gains one instruction line: classify each candidate
  into a namespace; when unsure, `general`.
- Migration test in `db_migrations.rs` tests module (existing users: all rows
  backfill to `general` — no behavior change).

### 2.2 Agent experience store — Phase 1

One distilled row per completed supervisor plan. Table
(migration `0011_agent_experiences.sql`):

```sql
CREATE TABLE agent_experiences (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id INTEGER NOT NULL,
  task_summary TEXT NOT NULL,
  lesson TEXT NOT NULL DEFAULT '',
  tool_sequence TEXT NOT NULL DEFAULT '[]',   -- JSON array of tool names
  outcome TEXT NOT NULL,                      -- 'success' | 'partial' | 'failed'
  tags TEXT NOT NULL DEFAULT '[]',            -- JSON array
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_experiences_agent ON agent_experiences(agent_id, created_at);
```

- Written by `src-tauri/src/supervisor.rs` at plan completion (it already
  holds every step outcome). `lesson` generation: one bounded `remote_llm`
  call summarizing "what worked / what to do differently" — **skipped
  silently when the vault is empty** (row still written with empty lesson).
  Cap: keep the latest `KAWAI_EXPERIENCE_MAX` (default 200) rows per agent;
  prune on write.
- Consumed in two places:
  1. **Materials rendering** (hybrid subagent path): top-k experiences for the
     executing `agent_id` render into the subagent materials block, ranked by
     recency + tag overlap with the current goal (string-token overlap is
     enough; no embeddings).
  2. **Planner context**: `plan_task` includes the last N (default 3)
     experiences for the agent so the planner avoids repeating failed tool
     sequences.
- New ops: `experience_list(agentId?, sessionId?)` and
  `experience_delete(id)` (both wrappers; auth-required). Surfaced on the
  Memory asset page as an "Experiences" tab (read-only list + delete).
- New crate module: `crates/engines/agent/src/experience.rs` (pure; DB via
  `kawai-db` connection helper passed in, mirroring `evidence_cache`).

### 2.3 Onboarding context-gathering pipeline — Phase 2 (ships the "minutes")

New module `crates/engines/onboarding` (`kawai-onboarding`; deps: `kawai-db`,
`kawai-memory`, `remote-llm`, `ragloader`, `kawai-integrations-gmail` behind
Phase 3). Pipeline stages, all skippable:

```
[connect gmail]      → Phase 3 (opt-in; OAuth deep-link)
[import documents]   → LinkedIn export / resume / bio (ragloader → text)
[quick questions]    → 3 optional prompts (name/role, focus, top goal)
[compress]           → remote_llm one-shot → structured profile JSON
[persist]            → memories rows (namespace='profile'|'people'|'goals')
```

- Compression prompt outputs strict JSON:
  `{ "profile": [{title, content}], "people": [...], "goals": [...] }`,
  validated, deduped against existing titles (reuse `memory_extract`'s dedup
  loop — factor it into a shared `store_candidates` fn).
- **Source-plan concept**: the pipeline is data-driven — a `Vec<SourcePlan>`
  where each plan is `GmailPlan`, `DocumentPlan { file_id }`, or
  `QuestionsPlan { answers }`. Finished sources are recorded in a
  `kv`-style row (`onboarding_state`) so re-runs only process new sources.
- **Skip semantics** (mirrors openhuman's `ContextGatheringStep`
  `if (!hasGmail) skip-all`): stages with unmet preconditions report
  `sourceCompleted { itemsFound: 0 }` and move on — the LinkedIn stage
  requires an extracted (or manually entered) profile URL, the Apify stage
  additionally requires `KAWAI_APIFY_API_KEY` + consent. A run with zero
  available sources still completes (`totalItems: 0`) and marks onboarding
  done; the user is never blocked from chat.

New events — `OnboardingEvent` in `crates/foundation/events/src/lib.rs`
(`#[serde(tag = "type")]`, terminal variants `onboardingFinished` /
`onboardingError`):

```
sourceStarted { source } | sourceProgress { source, note }
sourceCompleted { source, itemsFound }
compressStarted | profileReady { counts }
onboardingFinished { totalItems } | onboardingError { message }
```

New ops (one snake_case name each, both wrappers):

- `onboarding_status()` → `{ completed, sources: [...] }` (public? no —
  auth-required; reads `onboarding_state`).
- `onboarding_run(stream_id, sources[], channel)` — streaming; registers a
  `CancellationToken` in the shared registry like every streaming command
  (skippable mid-flight via the existing cancel path).
- `onboarding_skip()` — marks state completed with zero sources (never
  auto-prompts again).
- `onboarding_reset()` — clears state + profile-namespace rows (dev/re-run).

Wire-up: `logic/onboarding.rs` shim → crate; command in `commands.rs`; SSE
route in `web.rs` (protected router); `generate_handler!` in `lib.rs`;
frontend hook `frontend/src/hooks/use-onboarding.ts` (mirrors
`use-supervisor-plan.ts`: `streamOperation<OnboardingEvent>`, TS bindings
regenerated, new variants matched — no silent drops).

**Frontend**: a `ContextGatheringStep` after `auth-gate` on first launch
(gated by `onboarding_status.completed === false`): cards for the three
sources, live progress list from events, "Skip" always visible. Dark theme,
existing `ui/` components.

### 2.4 Gmail connector — Phase 3

New crate `crates/integrations/gmail` (pure client, reqwest; no kawai deps):

- OAuth: Google installed-app flow. `gmail_connect_start()` returns the
  consent URL (scope `gmail.readonly` only) + PKCE verifier; Google redirects
  to `kawai://gmail?code=…`; frontend deep-link handler (pattern identical to
  `kawai://auth` in `use-auth.ts`) captures it and calls
  `gmail_connect_finish(code, verifier)`. Tokens (access + refresh) go to the
  **OS keychain** via `keychain.rs`, never the DB.
- Scan API (called by the onboarding engine, in-memory only):
  - `recent_contacts(limit)` — `from` aggregation over the last 90 days of
    sent + received headers → people candidates (name/email/frequency).
  - `topic_hints()` — subjects + mailing-list names of recent mail,
    bucketed, → interest candidates.
  - Bounded: `KAWAI_GMAIL_MAX_MESSAGES` (default 300) headers fetched via
    `messages.list` + batch `messages.get(format=metadata)`; bodies are
    requested **only** by the LinkedIn-URL stage below — capped at
    `KAWAI_GMAIL_LINKEDIN_SCAN_MAX` (default 10, matching openhuman's
    `max_results: 10`) — extracted, and never persisted.
- Env (genuinely new — nothing existing serves Google OAuth):
  `KAWAI_GMAIL_CLIENT_ID` / `KAWAI_GMAIL_CLIENT_SECRET`. Desktop
  installed-app clients carry a public secret by design (documented in
  `.env` sample); the trust boundary is the user's own Google account
  consent, and the scope is read-only metadata.
- **LinkedIn-URL extraction stage** (the openhuman trick, ported): fetch
  `from:linkedin.com` messages with bodies, regex with two priorities —
  priority 1 `linkedin.com/comm/in/<user>` (notification emails always
  reference the recipient's own profile, so this is the reliable self-URL),
  priority 2 `linkedin.com/in/<user>`. First hit wins → the URL is handed
  to §2.5; bodies and all other matches are dropped in-memory. Plain-text
  parts first, base64-decoded HTML parts as fallback (same walk order as
  openhuman's `search_gmail_for_linkedin`).

### 2.5 LinkedIn enrichment + document import — Phase 3

Three paths into the same compressor, ascending effort/risk:

1. **Data-export import (default, zero deps).** Op
   `onboarding_import_document(file_id)`: user drops the LinkedIn export
   zip (or resume/bio) into the onboarding card; ragloader extracts text;
   the engine treats it as a `DocumentPlan` source. ragloader already
   handles HTML/PDF/docx; CSV Profile rows (positions, education) get a
   small line-oriented extractor in the onboarding crate. File association
   follows the existing `session_files` / knowledge-add pattern.
2. **Apify actor scrape (opt-in, API-key-gated).** When §2.4 produced a
   profile URL *and* `KAWAI_APIFY_API_KEY` is set *and* the user confirms
   the consent dialog, `crates/integrations/apify` runs
   `POST https://api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items`
   with `{ "profileUrls": ["<url>"] }` (sync, 120 s timeout). Response JSON
   (name, headline, company, education, skills) is rendered to Markdown,
   compressed by the same LLM pass as every other source, and stored with
   `source='linkedin'` + provenance (url, actor id). kawai never talks to
   LinkedIn directly — the scrape and its ToS exposure live on Apify's
   platform. No key or consent ⇒ stage skips silently.
3. **URL-only fallback.** If the Apify run fails or is unconfigured but a
   URL was extracted, the compressor still receives
   "LinkedIn profile: <url>" as an identity hint — enough to seed facets
   and let the user fill in the rest (openhuman's URL-only fallback).

### 2.6 Profile facets + FacetCache — Phase 4 (last, builds on 2.1)

OpenHuman's facet table, minimal port. Migration
`0012_profile_facets.sql`:

```sql
CREATE TABLE profile_facets (
  key TEXT PRIMARY KEY,          -- 'identity/role', 'style/verbosity', 'goal/2026-h1'
  class TEXT NOT NULL,           -- 'identity' | 'style' | 'tooling' | 'goal'
  value TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0.5,
  user_state TEXT NOT NULL DEFAULT 'active',  -- active | pinned | dropped
  updated_at INTEGER NOT NULL
);
```

- `crates/foundation/memory/src/facets.rs`: `facet_upsert / facet_list /
  facet_pin / facet_forget / facet_drop_below` + `class_from_key`
  (4 classes, not 6 — `veto`/`channel` don't map to anything kawai has).
- **Rebuild path**: a `facet_distill` pass runs after every
  `memory_extract`/onboarding compress: pull `profile`-namespace memories →
  one LLM call → facet upserts (existing key ⇒ `stability += 0.1` capped 1.0;
  absent ⇒ decay `−0.2`; `< 0.2` ⇒ dropped). Deterministic, unit-testable
  with a scripted LLM double.
- **Injection**: new `<profile>` prompt block at opener build (after
  memories), cap 2,000 chars / 16 facets, pinned first, active-only. This is
  kawai's PROFILE.md — except injection is from the facet table, so there is
  no markdown file to keep in sync.
- Ops: `facet_list`, `facet_pin(key, pinned)`, `facet_forget(key)`,
  `facet_reset_non_pinned` (parity with openhuman's reset semantics: report
  deleted vs pinned-preserved). Surface as a "Profile" tab on the Memory
  asset page.
- Deprecation pressure (NOT removal): once facets cover `profile` memories,
  `memory_extract` stops emitting `profile`-namespace rows and emits facet
  candidates directly; old rows are folded in by the first distill.

### 2.7 Continuous learning loop — Phase 4+

Deferred until sources stabilize: `tokio::spawn` + `interval` that re-runs
`facet_distill` + gmail topic refresh daily while the app runs, with a
`KAWAI_LEARN_DISABLED=1` kill-switch. Until then everything is
user-triggered (onboarding re-run, memory_extract button), which also keeps
cost predictable.

---

## 3. Prompt budget accounting (on-device prefill is the constraint)

| Block | Cap today | After plan |
|---|---|---|
| `<memories>` | 800c/item · 4k total · 24 items | unchanged (+namespace filter, pinned-first) |
| `<skills>` | 4k/skill · 12k total | unchanged |
| `<profile>` (new) | — | 2k total · 16 facets |
| experiences in materials | existing materials budget | drawn from the same per-provider budget, no new fuse |

`KAWAI_REMOTE_LLM_MATERIALS_CHARS` remains the single absolute fuse —
experiences render inside the existing materials renderer, not beside it.

---

## 4. File-level change list

### Implemented files

```
crates/foundation/memory/src/lib.rs        # namespace filter, pinned-first, shared store_candidates
crates/foundation/memory/src/facets.rs     # NEW: facet store + prompt block + distill types
crates/foundation/events/src/lib.rs        # OnboardingEvent (+ regenerate TS bindings)
crates/engines/agent/src/experience.rs     # NEW: experience rows + top-k query
crates/engines/onboarding/                 # NEW crate: pipeline engine (sources, compress, persist)
crates/integrations/gmail/                 # NEW crate (Phase 3): Composio response adapter + LinkedIn-URL extraction
crates/integrations/apify/                 # IMPLEMENTED: run-sync actor client + LinkedIn normalization
crates/engines/onboarding/                 # IMPLEMENTED foundation: identity + search discovery/ranking
src-tauri/migrations/0010_memory_namespaces.sql
src-tauri/migrations/0011_agent_experiences.sql
src-tauri/migrations/0012_profile_facets.sql
src-tauri/src/logic/onboarding.rs          # shim → kawai-onboarding
src-tauri/src/logic/memory.rs              # facet/experience re-exports
src-tauri/src/supervisor.rs                # experience write at plan completion
src-tauri/src/commands.rs                  # onboarding_* / experience_* / facet_* / gmail_* commands
src-tauri/src/web.rs                       # same ops on protected router (SSE for onboarding_run)
src-tauri/src/lib.rs                       # generate_handler! + deep-link kawai://gmail registration
src-tauri/tauri.conf.json                  # deep-link desktop scheme kawai://gmail
frontend/src/hooks/use-onboarding.ts       # NEW: OnboardingEvent stream hook
frontend/src/pages/…/ContextGatheringStep  # NEW: post-auth onboarding screen
frontend Memory page                       # tabs: L1 | Experiences | Profile (facets)
.env                                       # KAWAI_GMAIL_CLIENT_ID/SECRET, KAWAI_GMAIL_MAX_MESSAGES, KAWAI_GMAIL_LINKEDIN_SCAN_MAX, KAWAI_EXPERIENCE_MAX, KAWAI_APIFY_API_KEY (opt-in)
```

---

## 5. Implementation status

### Completed foundation

- `crates/integrations/apify`: vault-backed Personal API token resolution via
  `kawai_constants::apify::get_apify()`, bearer authentication, 120-second
  client-side timeout, optional `maxTotalChargeUsd`, bounded errors, generic
  actor runs, and LinkedIn profile normalization.
- `crates/engines/onboarding`: `IdentitySignals`, public GitHub profile
  fetching, privacy-preserving search-query construction (name/company/role/
  GitHub username; no email search), LinkedIn URL normalization and filtering,
  candidate deduplication, confidence scoring, and injected `SearchFn` so the
  engine remains independent of a search provider.
- Workspace registration for both crates in `crates/Cargo.toml`.
- Verification: `cargo test -p apify -p onboarding` — 47 tests passed.

### Remaining phases

**Phase 1 — namespaces + experiences** (no new deps, no UI risk)
Migration 0010 + 0011; memory namespace filter; experience write/read;
planner + materials wiring; Memory page Experiences tab.
Gate: `cargo test -p kawai-db -p kawai-agent -p kawai-memory`, migration
tests, `cargo check --features web`, `bun run build`.

**Phase 2 — onboarding pipeline + UI** (ships the claim; sources =
GitHub/public identity + documents + quick questions; Gmail discovery is
Phase 3)
kawai-onboarding orchestration; SearchFn adapter over `webread::search_web`;
OnboardingEvent + TS bindings; `onboarding_*` ops + wrappers;
ContextGatheringStep; `onboarding_smoke` example (offline: fixture search +
single Apify fixture + scripted LLM → asserts candidates, consent boundary,
memories written, and events ordered).
Gate: example green, both wrappers verified, `cargo check --features litert,office`.

**Phase 3 — connectors + LinkedIn enrichment** (Gmail via the existing
Composio integration, GitHub identity ingestion, document import, Apify
opt-in)
Gate: `apify`/GitHub tests against wiremock-style fixtures (no network in CI),
onboarding_smoke extended with fixture Gmail messages + fixture Apify dataset
responses (asserts both regex priorities, body discard, URL-only fallback),
manual Composio Gmail + Apify verification on macOS. Do not introduce direct
Google OAuth until the Composio-vs-direct decision in §6 is resolved.

**Phase 4 — facets + distill** (0012, `<profile>` block, Profile tab,
memory_extract emits facet candidates)
Gate: `facets.rs` unit tests (class parsing, decay math, caps),
`onboarding_smoke` asserts facet rows, prompt-budget test (≤2k chars).

Every phase keeps the standing rulebook: pure logic in crates, dual
wrappers, identity at the edge, `bun run build` + `cargo check` +
`cargo check --features web` green, doc hygiene in AGENTS.md/ARCHITECTURE.md
in the same commit.

---

## 6. Risks / decisions to confirm

1. **Google OAuth secret in a shipped desktop binary** — installed-app flow
   is Google-sanctioned, but if we ever ship a web build (kawai-web), the
   secret must move server-side. Alternative worth deciding **before Phase
   3**: openhuman routes Gmail through **Composio** — one OAuth broker
   covers Gmail + Discord/Slack/GitHub toolkits with zero per-provider
   code, at the cost of a third-party dependency and an API key in every
   user's trust chain. Direct Google OAuth keeps kawai local-first. Pick
   one; don't ship both.
2. **Apify actor = third-party cloud service** receiving the user's profile
   URL and returning scraped profile JSON. Mitigations: opt-in only,
   consent dialog names the actor, provenance on every produced memory row,
   and path 1 (data export) is the permanent fallback if the actor breaks
   or is taken down — the pipeline treats it as just another source.
3. **Body reads are confined to the LinkedIn-URL stage** (≤10
   `from:linkedin.com` messages; URL extracted, bodies discarded,
   never persisted) — the contacts/topics path stays metadata-only. If
   extraction quality is too low, the fallback is asking the user to
   export `mbox` and import it as a document — same pipeline, explicit
   consent, zero OAuth.
4. **Facet stability math** (±0.1/−0.2, drop <0.2) is a starting guess; tune
   against `turn_log` evidence once Phase 4 is live.
5. **Cost**: compress + distill are two extra remote calls per onboarding run
   and per memory_extract — bounded, user-triggered, and fuse-protected by
   the existing materials budget. No silent background spend until §2.7.
