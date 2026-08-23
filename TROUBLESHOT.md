# TROUBLESHOOT — debugging the agent pipeline

Runbook for coding agents diagnosing agent / tool-calling / hybrid-cloud
failures. Examples assume the dev-bypass user `demo` and the default macOS
data dir.

**Procedure — follow in order:**
1. §1: collect evidence (DB + turn_log + app.log). Never reason past missing
   evidence — run the queries, don't assume.
2. §2: compare the trace against a healthy turn.
3. §3: match symptoms to an entry; run that entry's Check commands verbatim
   and compare output against the stated expectations BEFORE changing code.
4. Fix. Every §3 Action names the exact file(s) to touch.
5. §4: run the verification block — a fix is not done until all of it passes
   and the retried prompt produces a §2-shaped healthy turn.

## 1. Evidence sources (read these first — never guess)

```sh
DB="$HOME/Library/Application Support/pro.kawai.app/demo/kawai.db"
LOG="$HOME/Library/Logs/kawai/app.log"     # symlink: ./app.log at repo root

# What the user & model said (raw — includes any leaked markup)
sqlite3 "$DB" "SELECT id, session_id, role, length(content), substr(replace(content,char(10),' '),1,120), created_at FROM messages ORDER BY id DESC LIMIT 10;"

# Per-turn telemetry: provider, tool, tokens, latency, outcome
sqlite3 "$DB" "SELECT id, session_id, provider, tool, input_tokens, output_tokens, latency_ms, outcome, created_at FROM turn_log ORDER BY id DESC LIMIT 10;"

# Loop execution trace (the most informative grep)
grep -a "agent_chat\]\|remote\]\|office\]" "$LOG" | tail -n 30
```

Quick diagnosis table (`turn_log.outcome`):

| Observation | Meaning |
|---|---|
| `answer`, `tool` set | healthy turn, tool ran (check `latency_ms` is proportional to output) |
| `answer`, `tool` empty, `provider=local` | model answered by itself (degraded OR legitimately short — check messages) |
| `error`, `tool=deep_write` | cloud failed → find the `deep_write failed:` line in the log |
| `answer`, `output_tokens` == output cap | answer cut at the provider cap (see §3.7) |

## 2. What a HEALTHY turn looks like in the log

```
[agent_chat] toolset for agent=builtin.office remote.is_some()=true has_toolset=true
[agent_chat] reset conversation for takeover (agent=builtin.office)   ← new epoch only
[agent_chat] tool call 1/8: knowledge_search args={...}
[agent_chat] tool result knowledge_search: ok=true {"hits":[... "fileId":"..."}]}
[agent_chat] tool call 2/8: office_read_document args={"fileId":"..."}
[agent_chat] tool result office_read_document: ok=true {"markdown":"..."}
[agent_chat] deep_write (delegated): task=<short brief>
[agent_chat] reset conversation after deep_write passthrough          ← REQUIRED after passthrough
```

Normal latency: cloud (zai) ~80–90 tok/s (7.5k tokens ≈ 90 s); each local
on-device generation takes 5–30 s depending on the call-line length.

## 3. Symptom → root cause → action

### 3.1 No response at all (0 chars, <1 s)

- **Check**: `messages` assistant row with `length=0`; `turn_log` `local`,
  `output_tokens=0`, latency ~400 ms.
- **Root cause**: local generation returned empty (immediate EOS). Class:
  engine state dangling mid-tool-lifecycle (e.g. the previous turn ended in a
  passthrough without reset), or other corrupted state.
- **Action**: the guard (one retry nudge) already exists. If it recurs, check
  whether `reset conversation after deep_write passthrough` IS present in the
  previous turn's log — if absent you are running an old backend build; if
  present and still empty, reproduce with `agent_smoke` and report the engine
  state.

### 3.2 Refusal answer ("I cannot access YouTube/videos")

- **Check**: `turn_log` `local`, `tool` empty.
- **Root cause**: the model doesn't know the content is in the knowledge base
  (it never called `knowledge_search`).
- **Action**: verify the file is imported AND associated:
  ```sh
  sqlite3 "$DB" "SELECT * FROM rag_files; SELECT * FROM session_files;"
  ```
  `rag_files.status` must be `ready`. If `failed` → retry from the Knowledge
  panel (read the `error` column). If the file exists but the session_id is
  missing from `session_files` → re-add via the panel (association lost).

### 3.3 Raw markup on screen (`<|tool_call>call:...`, `call:name{...}`)

- **Check**: `messages` assistant row contains a literal `call:` / `<|tool_call>`.
- **Root cause**: the parser didn't recognize the emitted format → treated as a
  final answer. The parser accepts: the ```tool fence, native
  `<|tool_call>...<tool_call|>` wrappers, bare `call:NAME{json}` (plus keys
  missing their opening quote, `<|"|>` escapes).
- **Action**: copy the exact shape from `messages`, add a `parse_tool_call`
  unit test in `src-tauri/src/logic/agent.rs` with it, extend the parser. The
  frontend `stripToolMarkup` (use-local-chat.ts) is the display safety net —
  if the markup reaches it too, extend its regex.

### 3.4 Tool card appears then VANISHES, no answer

- **Check**: `messages` assistant row contains `call:...` plus **broken JSON**
  (string self-truncated as `... "`, a key missing its opening quote `",task":`).
- **Root cause**: the model typed a huge payload (a copied materials/text) and
  gave up mid-way — invalid JSON, unbalanced braces → parser returns `None` →
  raw persist → frontend strips it → empty display.
- **Action**: this class is closed by two policies: (a) materials stay a
  one-line pointer (the injection system attaches tool results — never let the
  persona suggest pasting long text again), (b) the parser repair path. A NEW
  broken shape → unit test + extend `quote_bare_keys` / the repair retry.

### 3.4b Recognizable-but-broken `call:` lines persisted raw

- **Check**: `messages` assistant row contains one or more `call:NAME{...}`
  lines where the NAME is a real tool but the args are invalid JSON
  (consecutive string values, doubled tool-name suffix, `file_Id` casing).
- **Root cause**: a bare-call candidate with a valid name + BALANCED braces
  whose args fail to parse is surfaced as a malformed call → ONE repair
  round teaches the correct shape. If the repair also fails and no remote
  is configured, the raw line can still be persisted as the final answer.
- **Action**: the repair round normally closes this. A NEW arg-corruption
  shape → add a `parse_tool_call` unit test with the exact persisted text;
  if the shape is systematically repairable (like keys missing opening
  quotes), extend `quote_bare_keys` / the repair retry in agent.rs.

### 3.5 `office_read_document` error ("the tool failed")

- **Check**: log line `tool result office_read_document: ok=false`.
- **Root cause 1**: the model corrupted the fileId while copying it (missing/
  scrambled digits). A `fuzzy matched, retrying` log line = the LCS matcher
  saved it; without that line the corruption is below threshold (ratio <0.6 or
  ambiguous margin <0.1).
- **Root cause 2**: unsupported extension for the reader (all office formats
  plus `md` are supported; PDFs must use `pdf_extract_text`).
- **Action**: for heavy id corruption, model self-recovery via
  `office_list_files` is the normal path. A single-file-session shortcut could
  be considered (NOT implemented — a design decision).

### 3.6 "cloud writer returned an empty answer"

- **Check**: log line `deep_write failed: cloud writer returned an empty
  answer`; `turn_log` `error`, latency can be ~100 s.
- **Root cause**: the provider finished the stream without a transport error
  but zero text. Failover now happens IN-STREAM (the boundary is the first
  text token) — an empty provider goes to cooldown and the next candidate is
  tried.
- **Action**: if you still see this, ALL candidates were empty/failed → run
  `grep -a "\[remote\]" "$LOG"` for `attempt <label> ... trying next candidate`
  lines; the last failure is in `all remote candidates failed; last error: ...`.
  The local degradation that follows is EXPECTED behavior.

### 3.7 Answer cut off mid-sentence

- **Check**: `turn_log` `output_tokens` EXACTLY equals the cap
  (`KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS`, default 16384); the message tail may
  carry the marker `_[output truncated at the provider token cap]_`.
- **Root cause**: the provider stopped at max_tokens (not a natural finish).
- **Action**: raise the env var, or ask for less (a task brief with a maximum
  length). Do not raise the cap without bound — latency is linear in output
  (~80 tok/s).

### 3.8 Latency feels long

- **Check**: split the time. The zai `turn_log` row is purely the cloud phase.
  User-perceived total = local phase (number of Gemma generations × length) +
  cloud.
- **Normal**: cloud ~80–90 tok/s; local 5–30 s per generation.
- **Action**: reduce local steps (SOP violations → see 3.4/3.5), request
  shorter output, or accept it (a classic trade-off).

### 3.9 Prefill overflow ("exceeds available state entries")

- **Root cause**: context exceeds the K/V budget (`KAWAI_LLM_MAX_TOKENS`,
  default 8192). Automatic recovery: reset + one retry with a smaller
  transcript.
- **Action**: if it repeats on long sessions, lower `TOOL_RESULT_MODEL_CHARS` /
  the transcript budgets, or raise `KAWAI_LLM_MAX_TOKENS` (Gemma 4 max: 32003
  — K/V memory cost rises).

### 3.10 `sql: ... database is locked`

- Parallel tests sharing one DB file (flaky) → run with `-- --test-threads=1`.
- At runtime: make sure two app processes are not sharing the same data dir.

### 3.11 Empty search hits but the content IS there

- **Check**: `hits: []` while the document demonstrably contains the term:
  ```sh
  sqlite3 "$DB" "SELECT count(*) FROM rag_chunks WHERE file_id='<fid>' AND content LIKE '%<term>%';"
  ```
- **Root cause**: the model forwarded the user's whole phrase as the query;
  FTS token semantics dropped or missed it. The query builder ORs tokens and
  BM25-ranks them; the empty-hits note nudges the model to retry with ONE
  distinctive keyword.
- **Action**: if a query shape still misses, reproduce with the SQL above,
  then inspect `fts_match_query` (src-tauri/src/logic/rag.rs) and add a unit
  test for the shape.

### 3.12 web_read returns challenge text / budget exhausted

- **Check**: `app.log` line `tool result web_read: ok=true {"engine":"..."}`;
  the engine field names the tier that served the call.
- **Root cause (engine none + "bot-protected")**: tier-0 webview missed
  (marker detection or thin content) AND the Cloudflare render came back
  walled — hard JS-challenge site.
- **Root cause ("budget exhausted for today")**: `KAWAI_CF_PER_USER_DAILY`
  (user) or `KAWAI_CF_GLOBAL_DAILY` (dev-wallet fuse) cap hit; the tool
  result carries guidance, it is NOT an error.
- **Root cause (engine never "webview" on desktop)**: engine not registered —
  check `logic::scrape::set_webview_engine` runs in the `lib.rs` setup hook
  (office feature only); `kawai-web` and non-office builds are Cloudflare-only
  by design.
- **Action**: budget → raise the env cap or wait for the UTC-day rollover;
  walled page → nothing to fix locally (excluded by design); missing tier 0 →
  verify the office feature is compiled in.

## 4. Verification after a fix

```sh
bun run build                                  # frontend
cargo check && cargo check --features web \
  && cargo check --features litert,office      # backend, all variants
ABS="$PWD/cognee-litert-lm/native"
cd src-tauri && env LITERT_LM_LIB_DIR="$ABS" \
  RUSTFLAGS="-C link-arg=-Wl,-rpath,$ABS" LLVM_PROFILE_FILE=/dev/null \
  cargo test --features litert,office --lib -- --test-threads=1
```

Then retest e2e from the app (`bun tauri dev`) with the failing prompt, and
re-read §1 — a healthy turn must match the shape in §2.

## 5. Tool-calling protocol (quick reference)

- The manifest TEACHES: one line `call:NAME{"arg": "value"}` (the native Gemma
  body, plain quotes) → feedback arrives as `response:NAME: ...`.
- The parser ALSO ACCEPTS: the legacy ```tool fence, native wrappers
  `<|tool_call>call:NAME{...}<tool_call|>` (opener/terminator variants), the
  `<|"|>`/`<|'|>` escapes, keys missing their opening quote.
- Gemma special tokens (`<|tool|>`, `<|tool_response|>`, `<|channel>thought>`,
  `<|message|>`, `<|end|>`) are stripped from the display stream — they must
  never appear as prose.
- Subagent materials = a one-line pointer; the backend attaches the full
  content (`[tool results gathered this turn]`, 32k cap) or falls back to
  `[conversation so far]` when the turn ran no tools.
