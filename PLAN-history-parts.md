# PLAN — History parts: persist structured assistant turns (tool/reasoning cards)

Status: **DRAFT (2026-08-25)** — not yet implemented. One-line goal: **reloads
render tool cards + reasoning exactly as they streamed**, not plain text. No
UX change; old rows keep rendering via plain `content`.

## 1. Current state (grounded)

- **Schema** — `src-tauri/migrations/0001_baseline.sql`:
  `messages(id, session_id, role, content TEXT, created_at)`. No structured
  column. `src-tauri/src/logic/db.rs:278` (`list_chat_messages`) selects exactly
  those 5 columns; `:339` (`append_chat_message`) inserts `(session_id, role,
  content, created_at)` and seeds the session title on first user message.
- **Write path** — `src-tauri/src/logic/agent.rs` is the sole writer for
  assistant turns. Two append sites stream the final answer as a **plain string**:
  the local-answer branch (`:2087` `append_chat_message(sid, "assistant", &answer)`)
  and the cloud subagent passthrough (`:2628` same, inside the `deep_write`
  final branch). The in-flight `toolParts` / `reasoning` / `full` locals that
  build `use-local-chat.ts`'s streaming cards are **not serialized** — the
  `LocalChatEvent` union (`started/token/thinking/toolCall/subagentThinking/
  toolResult/finished/error`) is ephemeral. `use-local-chat.ts:177/187` commits
  them into `UIMessage[]` only in-memory.
- **Read path** — `frontend/src/lib/chat-helpers.ts:4` (`historyToMessages`)
  maps every row to a single `done` text part: `parts: [{type:"text", text:
  row.content}]`. Reloading a tool-using turn drops cards and collapses the
  transcript that the next `agent_chat` prompt replays (the prompt builder in
  `agent.rs:1697` currently replays truncated `content` strings only).
- **Frontend type** — `frontend/src/lib/api.ts:47` (`ChatMessageInfo`) carries
  `content: string` with no `parts` field. `use-local-chat.ts` already folds
  tool/reasoning parts during streaming; history is the only gap.

## 2. Goal

Reloaded history is visually and semantically identical to the live stream for
assistant turns that used tools or subagents. User turns stay unchanged. Old
rows (before this change) render exactly as today.

Non-goal for v1: persisting per-token timing, streaming `state` values, or
user file attachment previews beyond the IDs that already ride `fileIds`.

## 3. Design

### 3.1 Minimal schema change — one nullable JSON column

`src-tauri/migrations/0007_messages_parts.sql`:

```sql
ALTER TABLE messages ADD COLUMN parts TEXT;
-- NULL = legacy row (fallback to content). JSON array of UIMessage parts
-- for assistant turns that had cards/reasoning. TEXT keeps libsql's
-- existing binding shape; no new index needed.
```

Rationale: adding a column preserves every invariant (per-user DB, no
`user_id` column, `#[serde(tag="type")]` events untouched) and keeps the
migration idempotent. A separate `message_parts` table was considered and
rejected — one extra JSON column avoids join churn on every history load, and
the payload per row is small (a handful of tool summaries + text).

### 3.2 Backend — write structured parts alongside `content`

- **`logic/db.rs`** — extend both functions without breaking callers:
  - `list_chat_messages` selects `parts` as column 6 and maps it to a new
    `Option<String>` field on `ChatMessage` (serde `parts: Option<String>`).
  - `append_chat_message` gains an optional `parts_json: Option<&str>` arg
    (default `None` for the direct `logic.rs:append_chat_message` wrapper that
    the Tauri command uses). When `Some`, the INSERT includes `parts`; when
    `None`, the column stays NULL (legacy behavior). Overload via a private
    `append_chat_message_with_parts` to keep the public signature stable for
    `commands.rs`/`web.rs`.
- **`logic/agent.rs`** — at each assistant append site, serialize the turn's
  accumulated parts to JSON and pass it through:
  - Build a `Vec<StoredPart>` from the locals already in scope:
    `full` → `{type:"text", text: stripToolMarkup(full)}` (the same display
    text the stream used), `toolParts` → each `{type:"tool-…", toolCallId,
    state:"output-available"|"output-error", input, output}`, `reasoning` →
    `{type:"reasoning", text, provider}`. All with `state:"done"` since the
    turn is finished. `content` stays the human-readable transcript (joined
    text + tool summaries) for search/back-compat and for the prompt replayer
    that currently reads `content`.
  - Pass the JSON string to the new `append_chat_message_with_parts` arg at
    `:2087` and `:2628`. User-message append at `:1698` stays parts-free
    (plain text part only — no benefit to persisting it).
  - `draft_document`'s receipt tool-result is a normal `toolResult` card — it
    already enters `toolParts`, so no extra handling.

A `StoredPart` type lives in `logic/db.rs` (serde, `#[serde(tag="type")]`
compatible) and is kept intentionally narrow — text, reasoning, tool — to
avoid coupling to the full `UIMessagePart` union that the frontend evolves
faster in vendored `ai-types`.

### 3.3 Frontend — read structured parts when present

- **`lib/api.ts:ChatMessageInfo`** — add optional `parts?: string | null`
  (raw JSON from `parts` column, `null` for legacy rows). No new RPC shape is
  needed — `list_chat_messages` already returns `ChatMessageInfo[]`; the extra
  field is additive and `serde(rename_all="camelCase")` maps it.
- **`lib/chat-helpers.ts:historyToMessages`** — when `row.parts` is a valid
  JSON array of recognizable parts (validate `Array.isArray`, each entry has a
  `type` string), return those parts (coerced to `state:"done"` if missing).
  Otherwise fall back to the single text part from `row.content`. Invalid JSON
  is treated as missing (logWarn, fallback). A tiny `parseStoredParts` helper
  + 4–6 unit tests cover: legacy NULL → text fallback, full tool+reasoning
  round-trip, corrupted JSON → fallback, unknown `type` → dropped entry.
- No change to `use-local-chat.ts` streaming path — it already builds the same
  shapes live. The session switch (`selectSession`) will now show identical
  cards.

### 3.4 Prompt replay (follow-up, not blocking v1)

The next-turn prompt builder in `agent.rs:1697` currently compacts
`content` strings. With `parts` persisted, a future change can replay tool
summaries more faithfully (or replay the stored parts as `TOOL_RESULT` blocks)
without K/V bloat — the same `TOOL_RESULT_MODEL_CHARS` caps still apply.
This plan deliberately does **not** couple that improvement to the persistence
ship; v1's win is history rendering alone.

## 4. Compatibility

- **Old DB → new code**: `parts` is NULL → history falls back to `content`
  (byte-for-byte today's behavior).
- **New DB → old code** (rollback): the column is ignored — `SELECT id,
  session_id, role, content, created_at` still works; extra column is inert.
- **Old rows never backfilled** — no migration of existing assistant turns
  (their tool outputs are gone; re-synthesizing would hallucinate). Documented
  as expected.

## 5. Tests & verification

- `src-tauri/migrations/0007_messages_parts.sql` added + `Migration` entry in
  `src-tauri/src/logic/db_migrations.rs::migrations()` (per AGENTS.md §11
  checklist; covers `db_migrations.rs::tests`).
- `cargo check`, `cargo check --features web`, `cargo check --features litert`
  — web wrapper round-trips the new field without code change (shared
  `logic::db::list_chat_messages`).
- `bun run typecheck`, `bun run lint`, `bun run test` (new
  `chat-helpers.test.ts` cases for `historyToMessages` with/without parts).
- Manual: start a tool-using turn (analytics `data_query`, office
  `knowledge_search`, or cloud `deep_write`), reload the session → cards and
  reasoning reappear; legacy sessions still load.

## 6. File-level change map

```
src-tauri/migrations/0007_messages_parts.sql   NEW  ALTER TABLE messages ADD COLUMN parts TEXT
src-tauri/src/logic/db_migrations.rs          ADD  Migration entry for 0007
src-tauri/src/logic/db.rs                     MOD  ChatMessage.parts field; list/append handle parts
src-tauri/src/logic/agent.rs                  MOD  serialize parts at the two assistant append sites
frontend/src/lib/api.ts                       MOD  ChatMessageInfo.parts? field
frontend/src/lib/chat-helpers.ts              MOD  historyToMessages: parse parts when present
frontend/src/lib/chat-helpers.test.ts         ADD  cases for parts round-trip + fallback
```

No changes to `commands.rs`/`web.rs` beyond the new column flowing through
the existing `list_chat_messages` return (no new ops). No change to
`LocalChatEvent`.

## 7. Open question

Persisting user `fileIds` chips as a `file` part vs keeping them as separate
session-file associations (`session_files`). Chips already rehydrate from
`knowledge_list(inSession)`, so no persistence need — noted here to avoid a
second column.
