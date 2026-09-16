# TROUBLESHOOT — how to debug the agent pipeline

Method for diagnosing agent / tool-calling / hybrid-cloud failures. Examples
assume the default macOS data dir; identity = the login email.

## 1. Method (follow in order — never skip ahead)

1. **Reproduce.** If possible, use a probe example instead of the app
   (`src-tauri/examples`: `web_read_check`, `web_search_check`,
   `sql_remote_check`, LLM smokes) — it removes UI, session state, and the
   data dir from the equation.
2. **Collect evidence before any hypothesis.** Run the §2 queries. Never
   reason past missing evidence.
3. **Baseline against a healthy turn** (§3). The FIRST line where the trace
   diverges from healthy localizes the bug; everything before it works.
4. **Localize the layer**, top-down:

   | Divergence | Layer |
   |---|---|
   | Events never reached the frontend | transport (`commands.rs`/`web.rs`, `use-supervisor-plan.ts`) |
   | Model emitted raw `call:` markup | tool-call parser (§3.3-class) |
   | `tool result <name>: ok=false` | tool / args — read the exact error |
   | Result reached the log but the model ignored it | agent loop / context budget |
   | Cloud call failed (`turn_log` outcome, `[remote]` lines) | provider / failover |
   | Only inside the app, never in a probe | app shell (env, features, data dir) |

5. **Fix at that layer, minimally.** Guards already exist (repair rounds,
   failover, retries) — recurrence means a NEW shape/trigger; find it, don't
   re-implement the guard. New failure classes: add them to this file.
6. **Verify** (§5). Not done until all checks pass AND the original failing
   prompt produces a §3-shaped healthy turn.

## 2. Evidence sources

```sh
DB="$HOME/Library/Application Support/pro.kawai.app/demo/kawai.db"
LOG="$HOME/Library/Logs/kawai/app.log"     # symlink: ./app.log at repo root

sqlite3 "$DB" "SELECT id, role, length(content), substr(replace(content,char(10),' '),1,120), created_at FROM messages ORDER BY id DESC LIMIT 10;"
sqlite3 "$DB" "SELECT id, provider, tool, input_tokens, output_tokens, latency_ms, outcome, created_at FROM turn_log ORDER BY id DESC LIMIT 10;"
grep -a "agent_chat\]\|remote\]\|office\]\|supervisor\]\|webread\]" "$LOG" | tail -n 30
```

## 3. Healthy turn shape

```
[agent_chat] toolset for agent=… remote.is_some()=true has_toolset=true
[agent_chat] tool call N/M: <tool> args={…}
[agent_chat] tool result <tool>: ok=true {…}
[agent_chat] reset conversation after deep_write passthrough   ← required after passthrough
```

Normal: cloud ~80–90 tok/s; local Gemma 5–30 s per generation. `turn_log`
healthy row: `outcome=answer|tool` with `output_tokens` below the cap.

## 4. Common symptoms (quick index)

| Symptom | First check |
|---|---|
| 0-char answer, <1 s | prior turn had `reset … passthrough`? |
| Refusal ("I cannot access…") | `rag_files.status=ready` + row in `session_files`? |
| Raw `call:` markup persisted | add the exact text as a `parse_tool_call` unit test, extend parser |
| Tool card vanishes, broken JSON args | parser repair path; new arg-corruption shape → unit test |
| `office_read_document` ok=false | fileId corruption (LCS retry line?) or wrong tool for PDFs |
| "cloud writer returned an empty answer" | `grep -a "\[remote\]"` — all candidates failed = expected local fallback |
| Answer cut mid-sentence | `output_tokens` == cap (`KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS`) |
| "exceeds available state entries" | context over K/V budget → lower budgets or raise `KAWAI_LLM_MAX_TOKENS` (Gemma 4 max 32003) |
| `database is locked` | two processes on one data dir, or run tests `--test-threads=1` |
| Empty search hits despite content | model used whole-phrase query; test the shape against `fts_match_query` |
| `data_query_nl` invalid JSON / slow | `parse_llm_json` guards in place; >60 s = failover retries or local fallback; `timeoutMs: 120000` |
| `data_schema` columns named A, B, C (xlsx) | no header found — check the sheet's real shape: `cargo run -p analytics --example xlsx_probe -- <file> [sheet]`; if text samples are ALL null, the SST deref broke (see `cell_typed` in `analytics/src/excel.rs`); a pivot fragment with no header is correct output |
| xlsx text columns all `null` / text data vanished | shared strings not dereferenced — `CellValue::SharedString` must resolve via `XlsxDocument.shared_strings` (`get_shared`), not map to empty |
| PlanFailed after revise rounds | read logged `raw:` — repeated same failure = fix the prompt, not the validator |
| Deliverable is raw JSON | all providers failed synthesis; check `[remote]` per-candidate lines |
| web_read/search `engine=none` | budgets, walls, or relevance gates — probe with `web_read_check` / `web_search_check` |

Anything not here: work §1 step 4 and record what you find.

## 5. Verification after a fix

```sh
bun run build
cargo check && cargo check --features web && cargo check --features litert,full
cd src-tauri && env LITERT_LM_LIB_DIR="$PWD/../cognee-litert-lm/native" \
  RUSTFLAGS="-C link-arg=-Wl,-rpath,$PWD/../cognee-litert-lm/native" \
  LLVM_PROFILE_FILE=/dev/null cargo test --features litert --lib -- --test-threads=1
```

Then retest e2e (`bun tauri dev`) with the failing prompt; re-read §2 — the
turn must match §3.

## References (look up, don't read through)

- **Tool-calling protocol**: manifest teaches `call:NAME{"arg":"val"}`;
  feedback arrives as `response:NAME: …`; parser also accepts the ```tool
  fence, `<|tool_call>` wrappers, `<|"|>` escapes, unquoted keys. Special
  tokens never appear as prose.
- **Auth**: identity = login email; artifacts `<user_data_dir>/auth.token`
  (7-day Ed25519 bearer) + `<data_root>/last_session`. Sign-in failures →
  probe `POST /auth/salt` on the worker; 409-with-no-account → stale D1 row;
  session lost each restart → decode the token's `sub`/`exp`.
- **Agent Observability** (`crates/foundation/telemetry`): every cloud call
  exports to Grafana — generations via `gcx agento11y conversations get
  kawai-session-<id>`, traces via Tempo (`service.name="kawai"`), metrics
  `gen_ai_client_*` + `kawai_remote_failover`. Env-gated by `AGENTO11Y_*`/
  `OTEL_*`; one `glc_` token covers both channels. Agent roles: a NEW system
  prompt = a NEW role (`with_agent`/`reason_as`), or it collapses into
  `kawai-agent`. Short-lived processes must call
  `kawai_telemetry::shutdown()` before exit.
- **Connecting to Grafana**: stack = `giganticgecko512` (org slug lives in
  `~/.config/gcx/config.yaml`; refresh OAuth with `gcx cloud login` when
  commands 401). Read token = `GRAFANA_SERVICE_ACCOUNT_TOKEN` (glsa_) in
  `kawai/.env` — verify with a 1-liner before querying:
  ```sh
  source kawai/.env
  BASE="https://giganticgecko512.grafana.net/api/datasources/proxy/uid"
  curl -s -o /dev/null -w '%{http_code}\n' "$BASE/../../api/datasources" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"  # expect 200
  # traces (Tempo):
  curl -s "$BASE/grafanacloud-traces/api/search?tags=service.name%3Dkawai&limit=10" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"
  curl -s "$BASE/grafanacloud-traces/api/traces/<traceID>" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"   # waterfall
  # metrics (Prometheus — PromQL via GET/POST 'query='):
  curl -s "$BASE/grafanacloud-prom/api/v1/query" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
    --data-urlencode 'query=sum by (gen_ai_agent_name, gen_ai_provider_name) (increase(gen_ai_client_token_usage_total[24h]))'
  # handy: histogram_quantile(0.50|0.95, sum by (le, gen_ai_agent_name) (rate(gen_ai_client_operation_duration_bucket[5m])))
  #        sum by (reason) (increase(kawai_remote_failover[1h]))
  # logs (Loki — note the /loki/api/v1 path segment):
  curl -s -G "$BASE/grafanacloud-logs/loki/api/v1/query_range" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
    --data-urlencode 'query={service_name="kawai"}' --data-urlencode 'since=24h' --data-urlencode 'limit=20'
  # log labels: component (supervisor/remote_llm/…), user_id, severity_text, target
  ```
  Trace shape: root `remote_llm.stream` → child `remote_llm.attempt` per
  provider candidate → `streamText` span. Several attempts = failover. When
  to use which channel: local/log for repro, Tempo for "slow/empty but tools
  ran" (shows which provider served and why others were skipped), gcx for
  the actual prompts/responses. The Grafana MCP tool in agent sessions may
  401 (its own token) — fall back to the curl path above.
