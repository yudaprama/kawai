# TROUBLESHOOT — how to debug the agent pipeline

Method for diagnosing agent / tool-calling / hybrid-cloud failures. Examples
assume the default macOS data dir; identity = the login email (lowercased).
The per-user dir is the hex encoding of the email (`sanitize_user_dir` in
`crates/foundation/paths` — `[A-Za-z0-9_-]` passes through, anything else
hex-encodes, so every real email lands as hex).

## 1. Method (follow in order — never skip ahead)

1. **Reproduce.** If possible, use a probe example instead of the app
   (`src-tauri/examples`: `web_read_check`, `web_search_check`,
   `sql_remote_check`, LLM smokes) — it removes UI, session state, and the
   data dir from the equation.
2. **Collect evidence before any hypothesis.** Run the §2 queries (local
   sqlite/log AND the Grafana block for anything cloud-related — provider
   choice, failover, slow/empty generations, actual prompts). Never reason
   past missing evidence.
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
DB="$HOME/Library/Application Support/pro.kawai.app/6469656c7a7a7a383940676d61696c2e636f6d/kawai.db"
# dielzzz89@gmail.com hex-encoded. For another email:
# python3 -c "print(''.join(f'{b:02x}' for b in '<email>'.lower().encode()))"
LOG="$HOME/Library/Logs/kawai/app.log"     # symlink: ./app.log at repo root

sqlite3 "$DB" "SELECT id, role, length(content), substr(replace(content,char(10),' '),1,120), created_at FROM messages ORDER BY id DESC LIMIT 10;"
sqlite3 "$DB" "SELECT id, provider, tool, input_tokens, output_tokens, latency_ms, outcome, created_at FROM turn_log ORDER BY id DESC LIMIT 10;"
grep -a "agent_chat\]\|remote\]\|office\]\|supervisor\]\|webread\]" "$LOG" | tail -n 30
```

**Grafana (cloud evidence — MANDATORY for provider/failover/slow-generation
questions, not optional).** Stack `giganticgecko512`; read token
`GRAFANA_SERVICE_ACCOUNT_TOKEN` (glsa_) in `kawai/.env`. The Grafana MCP tool
may 401 (its own token) — go straight to curl. When to use which channel:
local/log for repro, Tempo for "slow/empty but tools ran" (which provider
served, why others were skipped), gcx for the actual prompts/responses.

```sh
source kawai/.env
BASE="https://giganticgecko512.grafana.net/api/datasources/proxy/uid"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/../../api/datasources" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"  # expect 200; 401 → `gcx cloud login` first
# traces (Tempo):
curl -s "$BASE/grafanacloud-traces/api/search?tags=service.name%3Dkawai&limit=10" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"
curl -s "$BASE/grafanacloud-traces/api/traces/<traceID>" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN"   # waterfall
# metrics (Prometheus — PromQL via GET/POST 'query='):
curl -s "$BASE/grafanacloud-prom/api/v1/query" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  --data-urlencode 'query=sum by (gen_ai_agent_name, gen_ai_provider_name) (increase(gen_ai_client_token_usage_total[24h]))'
# handy: histogram_quantile(0.50|0.95, sum by (le, gen_ai_agent_name) (rate(gen_ai_client_operation_duration_bucket[5m])))
#        sum by (reason) (increase("kawai.remote.failover"[1h]))
# logs (Loki — note the /loki/api/v1 path segment):
curl -s -G "$BASE/grafanacloud-logs/loki/api/v1/query_range" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  --data-urlencode 'query={service_name="kawai"}' --data-urlencode 'since=24h' --data-urlencode 'limit=20'
# log labels: component (supervisor/remote_llm/…), user_id, severity_text, target
# prompts/responses (Agent Observability):
gcx agento11y conversations get kawai-session-<id>
```

Trace shape: root `remote_llm.stream` → child `remote_llm.attempt` per
provider candidate → `streamText` span. Several attempts = failover.
Instrumentation details (roles, env gating, `shutdown()`): see References.

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
| Cloud call slow/empty but tools ran | Tempo: `service.name="kawai"` trace — which provider served, which attempts failed/skipped (§2 Grafana block) |
| Failover storm / provider health | Prometheus: `sum by (reason) (increase("kawai.remote.failover"[1h]))` + per-provider latency p95 |
| Answer cut mid-sentence | `output_tokens` == cap (`KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS`) |
| "exceeds available state entries" | context over K/V budget → lower budgets or raise `KAWAI_LLM_MAX_TOKENS` (Gemma 4 max 32003) |
| `database is locked` | two processes on one data dir, or run tests `--test-threads=1` |
| `duplicate column name: …` during any op / `bad parameter or other API misuse` at startup | two processes ran `ensure_schema` on one data dir — kill the second instance; the version rows self-heal on the next clean open |
| Empty search hits despite content | model used whole-phrase query; test the shape against `fts_match_query` |
| `data_query_nl` invalid JSON / slow | `parse_llm_json` guards in place; >60 s = failover retries or local fallback; `timeoutMs: 120000` |
| `data_schema` columns named A, B, C (xlsx) | no header found — check the sheet's real shape: `cargo run -p analytics --example xlsx_probe -- <file> [sheet]`; if text samples are ALL null, the SST deref broke (see `cell_typed` in `analytics/src/excel.rs`); a pivot fragment with no header is correct output |
| xlsx text columns all `null` / text data vanished | shared strings not dereferenced — `CellValue::SharedString` must resolve via `XlsxDocument.shared_strings` (`get_shared`), not map to empty |
| `data_chart` plan rejected: `missing required property 'x'` / `sortBy: expected "string", got array` | planner shapes vs chart schema — x now defaults to the sole groupBy column and sortBy accepts name / {column,descending} / list (2026-09 OCR backtest session burned every revise round on these) |
| `avg`/`sum` over percent text reads wrong ("95,5" → 955) | decimal-comma coercion in `agg_expr` (`engines/analytics/src/engine.rs`): thousands comma = exactly 3 digits after; otherwise decimal comma → dot |
| Deliverable reports 1 of N fetched items (e.g. 1 email of 5) | a fat JSON step output used to be head-truncated mid-element at the synthesis budget, so the writer saw only item #1 — materials now compact JSON (long strings clipped, whole array elements kept, "… N more items omitted" marker; `synthesis_materials` in `src-tauri/src/supervisor.rs`, regression-tested). Recurs → check `dispatch args=` for payload-fattening arguments (`verbose`/`include_payload` on Composio reads) |
| `composio_execute` 404 `Tool_ToolNotFound` for a slug the model invented | runtime guidance lists the toolkit's real slugs and the repair loop self-corrects (4 invented shapes so far). The planner ALSO gets a plan-time gate: goals naming a known toolkit prefetch the real slugs into a `<composio-actions>` block, plans naming an outside slug are rejected before execution, and a redundant `composio_list_tools` step for an already-prefetched toolkit is rejected too (the block text + gate both say "go straight to composio_execute" — the tool description's "discover first" instruction otherwise makes the planner plan a discovery step anyway). Retries no longer re-run the identical failing call — `FailureKind::Other` steps are non-retryable (`crates/router/src/scheduler.rs`) |
| `composio_list_tools` returns `[]` though the toolkit has actions (model then invents bindings/slugs) | a free-text `search` used to REPLACE the toolkit term in the API query, and a strict filter emptied the rest; the client now always queries `search=<toolkit>`, token-ranks the free-text client-side, and falls back to the full toolkit list on zero hits (`crates/toolsets/composio/src/client.rs`). Recurs → `cargo run -p composio --example list_tools_probe -- <toolkit> "<search>"` |
| `composio_execute` 400 code 1811 `ActionExecute_ConnectedAccountEntityIdRequired` ("User ID is required with connected account") | the execute call reached Composio without an owning `user_id` — the client now prefers the bound kawai login email and falls back to the connected account's recorded `user_id` (`crates/toolsets/composio/src/lib.rs`); if it recurs, check `supervisor_toolset(user_id)` was built with a non-empty email and that `execute_tool` sends `user_id`/`connected_account_id` |
| PlanFailed after revise rounds | read logged `raw:` — repeated same failure = fix the prompt, not the validator |
| Replan burned by frozen-step mandate violations | mechanical now — drift is auto-restored, log line `[supervisor] revise round N: frozen-step drift auto-restored: <ids>`; if the repaired plan still fails, check (a) every same-defect sibling is Failed, not Skipped (fail-fast used to bury them outside `failures()`), (b) the binding error's `(result keys: …)` / `(declared: …)` hint names a key the reviser actually bound |
| Deliverable is raw JSON | all providers failed synthesis; check `[remote]` per-candidate lines |
| web_read/search `engine=none` | budgets, walls, or relevance gates — probe with `web_read_check` / `web_search_check` |
| Crypto desk run reports no-data / stock-flavored sources | domain plumbing: step args carry `domain`, but `desk_role` social/news ignored it (stock sources only) and market keyed on Binance symbols only — non-Binance coins hit `-1121 Invalid symbol`. Fixed: CoinGecko fallback (`search_crypto` → `get_coin_detail`) + crypto Reddit subs; verify the fetched sources labeled CoinGecko/Reddit-crypto in the analyst output |
| Crypto desk fundamentals report narrates "Company fundamentals … all returned no data" and quotes `API error (HTTP 422): Missing parameter vs_currency` from the market overview | equity statement slots were stock-shaped statics for every domain (the LLM dutifully reported the six absent headings), `get_crypto_market`/`get_crypto_price` had no `vs_currency` default (empty placeholder → CoinGecko 422), the token profile was only fetched when Binance was empty (Binance stats carry no mcap/rank/supply/ATH; the top-10 overview never holds rank >10), and non-2xx arrives as error-as-content that `run_source_kind` passed to the materials verbatim. Fixed: domain-shaped fundamentals slots + token profile always fetched (`search_crypto` → `get_coin_detail`, compact-rendered) + `vs_currency=usd` defaults + the error envelope treated as a failed source (not cached → `(source unavailable)`). Verify: crypto fundamentals materials list Coin profile/24h stats/overview and no equity heading |

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
  exports to Grafana — query paths in §2. Env-gated by `AGENTO11Y_*`/
  `OTEL_*`; one `glc_` token covers both channels. Agent roles: a NEW system
  prompt = a NEW role (`with_agent`/`reason_as`), or it collapses into
  `kawai-agent`. Short-lived processes must call
  `kawai_telemetry::shutdown()` before exit. Org slug lives in
  `~/.config/gcx/config.yaml`; refresh OAuth with `gcx cloud login` when
  Grafana calls 401.
