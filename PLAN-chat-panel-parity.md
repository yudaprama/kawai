# Implementation Plan — Chat panel parity (`frontend/` vs `web/` SPA)

Status: DRAFT v1, not started. Gap analysis of kawai's React chat panel
(`frontend/src/App.tsx` + `hooks/use-local-chat.ts`) against the main
`ai-orchestration/web/` SPA chat (`chat-view.tsx`, `chat-composer.tsx`,
`chat-message-item.tsx`, `use-chat-thread.ts`). This plan lists what can be
implemented, what should be skipped (server-backed web features with no kawai
equivalent), and the phased order. All kawai invariants apply (AGENTS.md):
pure `logic`, both wrappers per op, `#[serde(tag = "type")]` events, camelCase
web structs, event-union updates in BOTH `use-local-chat.ts` and `agent.rs`.

---

## 0. Gap inventory and verdicts

| # | Feature (web/ reference) | kawai today | Verdict | Size |
|---|---|---|---|---|
| 1 | User-image parts rendered in history (`UserMessageAttachments`) | hook emits `file` parts (`use-local-chat.ts:282`) but `MessagePartView` renders only text+tool → images vanish on reload | **P1** — frontend only | S |
| 2 | Multi-image submit | only the FIRST image is sent (`App.tsx:354` finds one) | **P1** — frontend + prompt format | S |
| 3 | Copy on user messages too | copy button only on assistant messages | **P1** — frontend only | S |
| 4 | `StreamingActivityIndicator` (waiting for first token) | nothing between submit and first token | **P1** — frontend only | S |
| 5 | Escape stops generation (global) | stop only via submit button | **P1** — frontend only | S |
| 6 | Arrow-Up recalls last user message | — | **P1** — frontend only | S |
| 7 | Loading skeleton + retry on history load error | static error banner | **P1** — frontend only | S |
| 8 | Edit user message → truncate & resend (`handleEditUser`) | — | **P2** — needs new DB op + context strategy | M |
| 9 | Regenerate response (`handleRegenerate`) | — | **P2** — same infra as edit | M |
| 10 | Continue generation (`canContinue` + floating actions) | — | **P2** — needs backend support | M |
| 11 | Reasoning/thinking rendering (`Reasoning` collapsible) | toggle exists (`local_llm_set_thinking`) but thinking text is not surfaced | **P3** — needs event variant + C-API verification | M |
| 12 | Tool inspector side panel (`ChatInspector`) | inline JSON dump only | **P4** — nice to have | M |
| 13 | TTS speak per message | — | **P4** — Web Speech API, free | S |
| 14 | Share message | — | **P4** — clipboard share, free | S |
| 15 | Thumbs up/down feedback (persisted) | — | **P4** — needs `messages.feedback` column | S |
| 16 | Branch switcher ("1 of N" sibling responses) | — | **defer** — needs `parent_id` schema work | L |
| 17 | readOnly/archived sessions | no archive concept | **skip** for MVP | — |
| 18 | Model label per message | single local model — moot | **skip** | — |
| 19 | Human-in-the-loop approval cards (`data-approval`) | no interrupt mechanism in agent loop | **skip** until agent tier grows tools with side effects | — |
| 20 | Token/context meter (`estimateTokens` + `Context`) | — | **P4** optional; context window of local Gemma known → cheap | S |
| 21 | Adaptive composer layout (1-line ↔ multiline reflow) | static single layout | **P4** polish | S |
| 22 | Dynamic suggestions (`useSuggestions`) | static per-agent prompts (fine) | **skip** | — |
| 23 | Canvas artifact tab | placeholder ("Artifacts will appear here") | **out of scope here** — tracked by office-agent plan (generated docs land there) | — |
| 24 | @-mention composer, mode selector, connections, schedule | deliberately removed (Knowledge Tier 3 decision, 2026-08-19) | **do NOT re-add** | — |

---

## 1. Goals / Non-goals

**Goals**

1. Close the chat UX gaps that are purely frontend (P1) in one pass.
2. Land edit / regenerate / continue (P2) on a shared truncation + context
   strategy, with the minimal set of new backend ops (each: pure logic fn +
   `#[tauri::command]` + Axum route, per the op checklist).
3. Surface thinking output (P3) as a collapsible `Reasoning` part, matching
   the AI-SDK-v5 part shape the vendored `ai-elements/reasoning` expects.
4. Keep every web-SPA component port subject to the vendoring trims
   (no `ai` imports, no `react-i18next`, no Lexical, no `@/platform` beyond
   the slim adapter).

**Non-goals**

- Branching/multi-response (needs `messages.parent_id` + UI; defer with a
  note in Roadmap).
- Server-parity features that depend on the egent stack (approvals,
  connectors, scheduling, model selection, @-mention injection).
- Artifact canvas rendering (belongs to the office-agent plan).
- Any remote-model work.

---

## 2. P1 — pure frontend quick wins (no backend changes)

All in `frontend/src/App.tsx`, `hooks/use-local-chat.ts`,
`lib/ai-types.ts`. One PR; verify with `bun run build` only.

1. **Render user image parts.** In `MessagePartView`, render `file` parts
   (`part.type === "file"`) as a small thumbnail row above the text
   (`ai-elements/image.tsx` is already vendored; reuse it or a plain `<img>`
   with the data URL). Note: history reload cannot show images until P2.5
   (persistence) — for live sessions the data URL is still in the part.
2. **Send all images.** `ChatComposerInner.handleSubmit` currently picks the
   first `image/*` file. Change the contract to `images: string[]` (base64,
   no `data:` prefix), update `chat.send(text, imageB64s)` and the backend
   prompt assembly (check `local_chat`'s current single-image arg — the op
   takes one `image_b64`; extend to `images_b64: Vec<String>`, additive and
   camelCase-safe). While there: reject non-image attachments in the picker
   the way the files panel already classifies them.
3. **Copy on user messages.** Reuse the existing `useCopyButton` row for both
   roles (assistant keeps its current placement).
4. **First-token indicator.** While `status === "submitted"`, render a subtle
   pulsing dot / "thinking…" row at the bottom of `ConversationContent`
   (port `StreamingActivityIndicator` minus i18n). This doubles as feedback
   between submit and the first `token` event, which on CPU Gemma can take
   seconds.
5. **Esc stops generation.** Window keydown listener while busy →
   `chat.stop()` (mirrors `chat-composer.tsx:450-461`).
6. **Arrow-Up recall.** In the composer textarea's `onKeyDown`: empty draft +
   ArrowUp → prefill with the last user message text (compute from
   `chat.messages`; pass down as `lastUserText` prop like web does).
7. **History load retry.** When `list_chat_messages` fails (session selected
   but messages empty + error), show error + Retry button instead of the
   bare banner.

---

## 3. P2 — edit / regenerate / continue (shared infra)

### 3.1 The core problem

The engine context is **in-memory** (Conversation API slot in `local-llm`);
SQLite only stores `messages(id, session_id, role, content, created_at)`.
Editing turn *n* or regenerating turn *n+1* requires: (a) truncating the DB,
(b) making the next generation happen **with the right prior context** even
though the engine conversation no longer matches.

### 3.2 Strategy (mirrors the web SPA's model)

The web SPA is stateless server-side: it sends the full history on every
request and the egent rebuilds context via `buildConversationQuery`. Adopt
the same for the three ops — they all funnel into one mechanism:

- New pure op **`reset_conversation`** (`local-llm`): drops the in-memory
  engine conversation (exists partially as `local_llm_reset` — verify whether
  it also unloads the model; we want conversation-only reset so we don't pay
  model reload).
- New pure op **`local_chat` gains `history: Vec<{role, text}>`** (optional
  param, default empty = current behavior). When non-empty: reset the
  conversation, replay the history into the prompt as a single formatted
  transcript (transcript formatting fn shared with `agent.rs`'s prompt
  builder), then append the new user message. This is exactly
  `buildConversationQuery` ported to local chat.
- New DB op **`truncate_chat_messages(session_id, from_message_id)`**
  (pure `db.rs` fn + both wrappers): `DELETE FROM messages WHERE session_id =
  ? AND id >= ?`. Index `idx_messages_session` already covers it.

### 3.3 Flows

- **Edit user msg** (`App.tsx` + `use-local-chat.ts`): pencil on user
  messages → inline editor (port `InlineMessageEditor` minus i18n) → on save:
  `truncate_chat_messages(session, userMsg.id)` → rebuild the local message
  array → `send(editedText, images, history=remainingTurns)`.
- **Regenerate**: refresh on the last assistant message →
  `truncate_chat_messages(session, assistantMsg.id)` → `send` with
  `history = all remaining turns` and an empty new user text (backend treats
  empty text + history as "answer the last user turn again"). Disable while
  busy; only on the last assistant message (web parity).
- **Continue**: floating action row (port `ChatFloatingActions`) shown when
  last message is assistant and not busy → new param `continue: bool` on
  `local_chat` that sends an empty continuation nudge to the SAME in-memory
  conversation (no reset, no history). If the C API rejects empty prompts,
  fall back to a fixed "Continue." user turn that is NOT persisted to DB nor
  shown in UI.

### 3.4 Checklist per new op

For `truncate_chat_messages`: `db.rs` pure fn → `commands.rs` command →
`web.rs` route (`#[serde(rename_all = "camelCase")]` request) → register in
`lib.rs` `generate_handler!` → `call()` from the hook.
For `local_chat` param changes: touch `commands.rs`/`web.rs` request structs,
`agent.rs` matcher (unchanged event union), and `use-local-chat.ts`.

**P2.5 (optional add-on): persist image thumbnails.** If image messages
should survive restarts, extend `append_chat_message` with an optional
`images_json` column (`ALTER TABLE messages ADD COLUMN images_json TEXT
DEFAULT ''` — idempotent guard since migrations are additive-only) storing
small data-URL thumbnails. Otherwise document that images are session-live
only.

---

## 4. P3 — reasoning / thinking rendering

Current state: `set_thinking` flips the LiteRT thinking config, but thinking
text arrives inside the same `Token` stream (`chunk_text` extracts all
`content[].text`; the C callback has no thought flag in our wrapper) — so
thinking and answer are currently **interleaved into one text part**.

Plan:

1. **Verify the C API first** (spike): check whether LiteRT-LM's stream
   chunks tag thought parts (JSON shape of the chunk envelope — look for a
   `thought`/`role` marker on parts, or a separate callback in
   `conversation.rs`). If yes → emit a new `LocalChatEvent::Thought { text }`
   variant. If no → fallback: frontend separates `<think>…</think>`-style
   markers emitted by Gemma's template, if present.
2. Event plumbing (all of these, per Landmines): `LocalChatEvent` in
   `local-llm/src/lib.rs` (+`#[serde(tag="type")]`), SSE mapping in
   `web.rs local_event_to_sse`, `agent.rs` matcher arm, `LocalChatEvent`
   union in `use-local-chat.ts`.
3. Frontend: accumulate thought text into a `reasoning` part
   (`ai-types.ts` already has the shape) and render with the vendored
   `ai-elements/reasoning` (`Reasoning/ReasoningTrigger/ReasoningContent`),
   auto-open while streaming, collapsed when done (web behavior).
4. Surface the existing `toggleThinking` in the UI (header dropdown next to
   theme — "Thinking" switch calling `local_llm_set_thinking`). Currently
   the hook has the toggle but nothing in `App.tsx` exposes it.

---

## 5. P4 — cheap polish (independent, pick freely)

- **TTS speak** (`useSpeech` port using `speechSynthesis`, browser API):
  Volume2/VolumeX action on messages. S.
- **Share**: copy-to-clipboard with toast (clipboard.ts exists). S.
- **Feedback up/down**: `ALTER TABLE messages ADD COLUMN feedback TEXT` +
  `set_message_feedback(message_id, feedback)` op (both wrappers) +
  thumbs actions on assistant messages. S.
- **Token meter**: hardcode Gemma context window in a small
  `lib/tokens.ts`, show used/total while composing (port
  `ComposerFooterMeta` minus i18n). S.
- **Adaptive composer layout**: port `ComposerLayout` reflow (1-line ↔
  multiline + attachment state). S.
- **Tool inspector**: port `ChatInspector` as a right-side sheet listing the
  message's tool calls with input/output. M.

---

## 6. Deferred / skipped (with reasons, for the record)

- **Branches (16)**: needs `messages.parent_id` + sibling queries + UI —
  rework of the linear history assumption everywhere (list, title seeding,
  truncation). Revisit only after edit/regenerate prove the truncation path.
- **readOnly/archived (17), model label (18), approvals (19), suggestions
  (22)**: no backend concept / no agent interrupt mechanism / single local
  model. Revisit with the agent tier.
- **@-mention composer & friends (24)**: intentionally removed with Knowledge
  Tier 3 (2026-08-19) — the agent finds files via `knowledge_search`. Do not
  reintroduce submit-time injection.

---

## 7. Verification

Per phase, from `kawai/`:

```sh
bun run build                    # every phase (frontend)
cargo check                      # P2/P3/P4-feedback (backend touched)
cargo check --features web       # P2/P3/P4-feedback (new routes)
# mobile checks only when logic.rs/db.rs/shared deps change (P2, P3):
cargo ndk -t arm64-v8a -P 24 check
cargo check --target aarch64-apple-ios -sim 2>/dev/null || cargo check --target aarch64-apple-ios-sim
```

Manual: `tauri dev` flows — send/edit/regenerate/continue a turn, restart
app, confirm history; thinking toggle with a thinking-capable model.
