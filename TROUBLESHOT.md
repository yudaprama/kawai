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

### Run on a physical Android device over USB

```sh
adb devices                                              # phone seen + authorized?
bun run tauri:android dev                                # dev loop: build + install + logcat
bun tauri android build --apk --debug --target aarch64   # bundled debug APK (no dev server needed)
adb install -r -d src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n pro.kawai.app/.MainActivity
```

Gotchas, all hit for real:

- **First build is slow; installs can fail on versionCode.** If a CI release APK is on the phone, the dev build (lower versionCode) is rejected with `INSTALL_FAILED_VERSION_DOWNGRADE` — reinstall with `adb install -r -d` (keeps app data). If adb says `device unauthorized`, accept the RSA prompt on the phone screen.
- **`tauri android dev` needs the PHONE to reach the Mac's dev server.** It prints `Replacing devUrl host with <mac-LAN-IP>` and bakes that into the APK; the phone must be on the same Wi-Fi *without client isolation*. Symptoms of isolation: black screen / `ERR_CONNECTION_REFUSED` at `tauri.localhost` in the WebView, `ping` from the phone to the Mac loses 100%. Workaround when the Wi-Fi isolates clients: install the bundled debug APK (frontend baked in, no dev server) — do NOT chase `TAURI_DEV_HOST`, it doesn't change the baked devUrl.
- **Dev-server lifecycle:** `tauri android dev` owns the vite server; if it exits, vite dies with it and an already-installed dev APK shows `CONNECTION_REFUSED`. Either restart the dev loop or install the bundled APK.
- **No `litert` on Android** — dev/`tauri:android` builds use the `desktop` feature only; `scripts/stage-litert-android.sh` must stage the android `.so` before any `litert` build.

### Android device (physical phone or emulator)

There is no terminal on the device, so the desktop `LOG=` path does not
apply. The app writes the SAME `app.log` into its app-data dir (injected by
the Tauri shell in `lib.rs` — the platform default is not writable in a
sandbox and would silently disable ALL logging on-device).

```sh
adb devices                                   # is the phone seen?
adb logcat -c                                 # clear, then reproduce
adb logcat | grep -aE "kawai|RustWebView|chromium"   # live: stderr + webview console

# Pull the persistent log file (survives the app dying; logcat does not):
adb exec-out run-as pro.kawai.app cat files/logs/app.log > /tmp/kawai-android.log
tail -n 100 /tmp/kawai-android.log
```

- `run-as` only works on a DEBUG build. On a release APK the sandbox is
  unreadable — use `adb logcat` (and note that stderr is what you get).
- Rust `eprintln!` / `tracing` land in logcat via the process stderr; JS
  console output lands under the `chromium` tag. Both are mirrored to
  `files/logs/app.log` by the stderr tee (`logging.rs`).
- WebView DevTools: `chrome://inspect` on the desktop Chrome with
  `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`.

**Auth/login hangs on device** — the auth path emits `tracing` events
(`component="auth"`) carrying `user_id_hash`, the failing `stage`
(`salt` / `sign_in` / transport), the HTTP `status`, and `elapsed_ms`. That
 makes it queryable from Grafana with no device attached (next section). The
 client is bounded (10s connect / 30s total), so a stall surfaces as
 `auth server unreachable: <cause>` instead of an endless spinner. Common
 causes on a phone: captive portal / no real network, IPv6-first DNS, or the
 worker URL in `KAWAI_WORKER_URL` being unreachable from the device.

**Debug logs in, release fails instantly with `auth server unreachable:
error sending request`** → R8 stripped the TLS verifier. Release builds run
`optimization { enable = true }`; `org.rustls.platformverifier.
CertificateVerifier` is instantiated from Rust via JNI BY NAME, so R8 sees
it as dead code and removes it — every HTTPS call dies at the TLS layer
while debug (unminified) builds work. The keep rule lives in
`src-tauri/gen/android/app/proguard-rules.pro`; release-android.yml has a
"Verify TLS verifier survived R8" dex check that fails the build before the
APK can attach to a release.

An ENDLESS spinner (timeout never fires) is different: the auth request
future died before the timeout could. Check `adb logcat` for
`panicked at rustls-platform-verifier-0.7.0/src/android.rs:90: Expect
rustls-platform-verifier to be initialized` — that panic kills every Rust
HTTPS call (auth, JWKS, remote LLM, Loki push; the device then ships
NOTHING to Grafana, so an empty `{service="kawai", os="android"}` query is
itself a symptom). Fixed in the Tauri shell: `lib.rs` setup initializes the
verifier with the JNI context on Android (see the Landmines entry in
AGENTS.md). If login spins forever again, logcat first.

#### No USB / no adb (wireless) — use Grafana Cloud

A phone with no cable still reports to Grafana Cloud: the Loki credential is
compiled into the binary (`kawai-vault/constants`), so the device pushes on
its own over the network. Three rules decide what arrives:

1. **The layer carries `tracing` events only, gated by level.** Release
   builds ship WARN/ERROR; debug builds ship INFO and above (which is why a
   debug APK shows a startup line, `loki operational-log export active`,
   with the effective `loki_level`). A plain `eprintln!` reaches the local
   file + logcat and NOTHING else — any failure you need to see from a
   wireless device MUST be a `tracing::*` event. The `frontend_log` sink
   (`logging::write`) mirrors JS log levels into `tracing`, so JS
   errors/warnings ship too.
2. **The gate is `KAWAI_LOKI_LEVEL`** (`off|error|warn|info|debug|trace`) —
   read from the runtime env first, then from the value baked at compile
   time. A phone cannot export env into the app, so a RELEASE APK under test
   opts in at build time:
   `KAWAI_LOKI_LEVEL=info bun run tauri:android:apk` (or `build`). Rebuild —
   the value is compiled in, not read from `.env` at runtime.
3. It is best-effort with a bounded channel, so a device offline during the
   failure ships nothing — absence of an event is not proof of absence of a
   bug. A dead network/push is reported on-device only (`loki push failed
   (N lines dropped): …`, target `kawai_telemetry::loki`) and never via
   Loki itself.

```sh
source kawai/.env
L="https://giganticgecko512.grafana.net/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1"

# Auth failures, newest first (component="auth"):
curl -s -G "$L/query_range" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  --data-urlencode 'query={service="kawai", os="android"} |= "auth"' \
  --data-urlencode 'since=1h' --data-urlencode 'limit=50' | jq -r '.data.result[].values[][1]'

# Everything from an Android device, any component:
curl -s -G "$L/query_range" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  --data-urlencode 'query={service="kawai", os="android"}' --data-urlencode 'since=1h'

# Liveness only — did the app boot AND ship anything in the last hour?
curl -s -G "$L/query_range" -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" \
  --data-urlencode 'query={service="kawai", os="android"} |= "loki operational-log export active"' \
  --data-urlencode 'since=1h' --data-urlencode 'limit=10' | jq -r '.data.result[].values[][1]'
```

`os` is a Loki label, so `os="android"` isolates device logs from your
desktop session without touching the app. Users group under `user_id`; the
auth path emits a truncated `user_id_hash` (never the raw email) as the
`user_id` label. `app_version` distinguishes a locally built APK from a
published release.

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
| Plan "succeeds" but does the wrong action (e.g. email only DRAFTED, never sent) after a plan-time gate rejection | the gate's valid-slug list was a truncated API page — the default Composio page cut alphabetically-late actions (19 of 23 gmail actions; `GMAIL_SEND_EMAIL`/`GMAIL_SEND_DRAFT` missing), so the gate rejected the CORRECT slug and the corrective round downgraded the step. `list_tools` now follows `next_cursor` (≤5 pages, `cursor=` percent-encoded) and `plan_index` fetches are complete; lazy prefetch also covers plans that reach validation with composio steps but no search round (tool names leak via `<experiences>`, bypassing the search-branch prefetch hook — log line `[plan_task] composio prefetch (lazy): …`) |
| `composio_execute` 404 `Tool_ToolNotFound` for a slug the model invented | runtime guidance lists the toolkit's real slugs and the repair loop self-corrects (4 invented shapes so far). The planner ALSO gets a plan-time gate: goals naming a known toolkit prefetch the real slugs into a `<composio-actions>` block, plans naming an outside slug are rejected before execution, and a redundant `composio_list_tools` step for an already-prefetched toolkit is rejected too (the block text + gate both say "go straight to composio_execute" — the tool description's "discover first" instruction otherwise makes the planner plan a discovery step anyway). Retries no longer re-run the identical failing call — `FailureKind::Other` steps are non-retryable (`crates/router/src/scheduler.rs`) |
| `composio_list_tools` returns `[]` though the toolkit has actions (model then invents bindings/slugs) | a free-text `search` used to REPLACE the toolkit term in the API query, and a strict filter emptied the rest; the client now always queries `search=<toolkit>`, token-ranks the free-text client-side, and falls back to the full toolkit list on zero hits (`crates/toolsets/composio/src/client.rs`). Recurs → `cargo run -p composio --example list_tools_probe -- <toolkit> "<search>"` |
| `composio_execute` 400 code 1811 `ActionExecute_ConnectedAccountEntityIdRequired` ("User ID is required with connected account") | the execute call reached Composio without an owning `user_id` — the client now prefers the bound kawai login email and falls back to the connected account's recorded `user_id` (`crates/toolsets/composio/src/lib.rs`); if it recurs, check `supervisor_toolset(user_id)` was built with a non-empty email and that `execute_tool` sends `user_id`/`connected_account_id` |
| PlanFailed after revise rounds | read logged `raw:` — repeated same failure = fix the prompt, not the validator |
| `[plan_task] round N: off-protocol` though the excerpt looks like a plan (`{"goal":…,"summary":{…,"steps":[…` without `}` closing `summary`) | the planner wrote `steps` nested inside `summary` and left the root object unclosed — one missing `}` makes the whole reply unparseable for `extract_json_slice`, so a plan-shaped response burns as off-protocol (planner_smoke 2026-10-27 lost six straight rounds to the identical shape). Mechanical now — `repair_nested_steps_json` (`supervisor.rs`) closes the braces / lifts the nested steps before the note, and the repaired text goes through the NORMAL validator (log line `[plan_task] mechanical repair: …`). A different unparseable shape → read the raw reply from the round line (`KAWAI_PLANNER_DEBUG=1`) |
| FIXED-pipeline run (`run_security_audit`, desk, futures audits, screener, monthly close, trading performance, youtube) shows a REVISED plan mid-run (steps renamed/localized, scans parallelized, URL scheme rewritten) | the model reviser rebuilt the plan after a step failure — fixed runs no longer revise (`FixedRun::allow_model_revision = false`): a step that exhausts its retries fails the run honestly with `PlanFailed` naming the step and NO `planRevising`/`planRevised` event. Seeing a revision means the binary predates the lock |
| Replan burned by frozen-step mandate violations | mechanical now — drift is auto-restored, log line `[supervisor] revise round N: frozen-step drift auto-restored: <ids>`; if the repaired plan still fails, check (a) every same-defect sibling is Failed, not Skipped (fail-fast used to bury them outside `failures()`), (b) the binding error's `(result keys: …)` / `(declared: …)` hint names a key the reviser actually bound |

| Router/planner desk run burns `Repairing plan (attempt N)` rounds with wave-2 steps failing `argument resolution failed … no artifact or output key named 'report' on step's result` | the model repairer added an `"output"` name to a BARE binding (`{"fromStep": "d_fundamentals"}`) — desk_role reports are markdown, so no key can ever match and the resolver's error carried no hint (the producer has no `produces` contract; its result is not keyed JSON). Fixed 2026-10-31 mechanically: `repair_materials` renders bare bindings as `arg ← step (BARE — the step's whole output; never add an "output" name)`, and the resolver error now says `the output is not keyed JSON — bind the step bare: {"fromStep": …}` when the producer output is not an object. Fixed pipelines never revise (`allow_model_revision = false`) — this shape only fires on planner/template runs |
| A quick-look goal ("cek BTC 4H") claims the FULL desk pipeline — 13 steps, analyst debate → trade decision — when the user wanted a glance | depth mismatch: the layer-2 resolver matched the SUBJECT (BTC) but never weighed DEPTH — its prompt only excluded questions/chat, so any imperative market goal claimed the desk (the only registered market-analysis workflow). FIXED 2026-10-31 in the resolver prompt (NOT a keyword list — the phrasing space is open and a first-word list both under- and over-covers): ROUTER_RESOLVER_PROMPT now carries "Match DEPTH, not just subject — claim only when the goal asks for the pipeline's full depth (research/analysis/debate/audit/close); quick looks, single price/chart checks, or `cek` without a research verb ⇒ `{"template":null}` (the planner composes a lighter plan from `crypto_klines`/`crypto_price`)". The decline path (`{"template":null}` → planner) is unit-tested (`parse_router_claim_accepts_json_and_rejects_hedges`); the plan-review card remains the safety net. Layer-1 keyword claims are untouched — "analisis teknikal BTC" is an explicit research request. |

| Layer-1 keyword gate claims a pipeline for a goal that only MENTIONS the keyword ("tadi ada berita bullish soal NVDA, rangkum beritanya" → matched=["bullish"] → full 13-step desk run for a news summary — test-proven with the production keyword set) | keyword-as-mention: the layer-1 gate matches vocabulary anywhere in the goal, so a writing request carrying a market word claims the pipeline. FENCED 2026-10-31 the way the question gate works: `QUESTION_ANY_WORDS` now carries summarize-verbs (`rangkum`, `ringkas`, `rangkuman`, `summarize`, `summarise`) — non-pipeline writing intents answer from the planner, never claim. Regression: `summarize_intents_never_claim_a_pipeline`. Recurs with a NEW verb class → extend the same any-word list (closed, measured classes only); the plan-review card remains the catch-all |
| Deliverable is raw JSON | all providers failed synthesis; check `[remote]` per-candidate lines |
| web_read/search `engine=none` | budgets, walls, or relevance gates — probe with `web_read_check` / `web_search_check` |
| Crypto desk run reports no-data / stock-flavored sources | domain plumbing: step args carry `domain`, but `desk_role` social/news ignored it (stock sources only) and market keyed on Binance symbols only — non-Binance coins hit `-1121 Invalid symbol`. Fixed: CoinGecko fallback (`search_crypto` → `get_coin_detail`) + crypto Reddit subs; verify the fetched sources labeled CoinGecko/Reddit-crypto in the analyst output |
| Crypto desk fundamentals report narrates "Company fundamentals … all returned no data" and quotes `API error (HTTP 422): Missing parameter vs_currency` from the market overview | equity statement slots were stock-shaped statics for every domain (the LLM dutifully reported the six absent headings), `get_crypto_market`/`get_crypto_price` had no `vs_currency` default (empty placeholder → CoinGecko 422), the token profile was only fetched when Binance was empty (Binance stats carry no mcap/rank/supply/ATH; the top-10 overview never holds rank >10), and non-2xx arrives as error-as-content that `run_source_kind` passed to the materials verbatim. Fixed: domain-shaped fundamentals slots + token profile always fetched (`search_crypto` → `get_coin_detail`, compact-rendered) + `vs_currency=usd` defaults + the error envelope treated as a failed source (not cached → `(source unavailable)`). Verify: crypto fundamentals materials list Coin profile/24h stats/overview and no equity heading |

| Market analysis quotes an obviously wrong price for a coin (e.g. "BTC $33.93" — that is Grayscale's Bitcoin Mini Trust ETF on yfinance, not Bitcoin) | the desk ran the WRONG ASSET CLASS: `route_log` shows the goal claimed `template=desk` (`source=llm` = layer-2), but the `d_data` output's market sources carry `"source":"yfinance"` and equity-shaped fundamentals slots (cash flow / earnings). The claim paths left the `domain` slot unset and the build defaulted it to `"stock"`. FIXED 2026-10-31 — `kawai_router::domain_from_facts` derives the slot from the goal's equity intent at every claim path (layer-1 `facts_slots`, layer-2 resolver) and `build_desk` refuses a missing domain (recoverable router error, never a silently wrong run). Recurs → read `route_log` (`goal`, `template_id`, `source`) and the step's echoed `params` for `domain` |

| Fixed-plan phase ran on DEFAULT args (phase-1 output shows the default `selected:25` / default interval while the user chose another) | arg TYPE mismatch between plan and tool: `build_audit_plan` wrote the data step's `nonce` as a u128 JSON number while `FuturesAuditDataArgs.nonce: Option<String>` expects a string — `parse_args` failed and its `{}` fallback "succeeded" with all defaults, DISCARDING the error (kawai-tools `parse_args`). Diagnose via the dispatch log line (`args={…}` — unquoted nonce = number) vs the step's echoed `params`/output. Fixed 2026-10-12 (both steps carry `nonce.to_string()`, test `both_steps_carry_a_string_nonce`); any NEW fixed-plan step arg must match the tool's `Args` types exactly or the fallback hides the mismatch |

| Risk-audit report lists a "limitation" the audit did not emit (e.g. "only 9 of 183 positions detailed") with `summary.graded == usdmPositions, skippedByCap:0` | NOT an audit cap — the deliverable writer's materials compaction (`synthesis_materials` → `compact_step_output`, 12k chars/step) keeps whole `positions` rows (~1.2k chars each) until budget, then `"… N more items omitted"`; the writer honestly reports the 9 it saw. The full matrix is persisted in `supervisor_step_results` (the run view lazy-loads it via `supervisor_step_output`). The tool's own `limitations` array is authoritative — check it first |

| COIN-M positions missing from a `binance_futures_risk_audit` report (graded reports cover BOTH markets since 2026-10-12) | COIN-M grades through the keyless dapi path (`candles::Market::Coinm` → `/dapi/v1/klines`; notional derived from dapi exchangeInfo `contractSize` because positionRisk carries none). A COIN-M position with no verdict row → its klines fetch failed (check the row's `error` field / `errors` in `binance_futures_audit_data` output); its PnL still reports per settlement asset regardless |
| MEXC Futures Risk Audit shows a losing position as profitable (e.g. ETH_USDT long at a mark below entry rendered positive), reports shorts as longs, or rolls up impossible notional | FIXED 2026-10-20 — three wire-mapping bugs in `crates/toolsets/mexc/src/positions.rs`: (1) unrealized PnL was read from `realised`, which is REALIZED PnL (funding + closed volume) and is positive on a position that has collected funding; MEXC sends unrealized as `unRealizedPnl`. (2) `positionType` is a JSON NUMBER (`1` long, `2` short), but it was read with `text()`, so every row fell back to LONG: hedge-mode shorts became longs with positive size and the mirror PK `(venue, market, symbol, position_side)` collapsed both legs into one row. Now read through `position_type_code` (number or string). (3) `holdVol` is a CONTRACT count, yet notional was `contracts × price`, off by `contractSize` (BTC_USDT 0.0001 → 10,000× overstated; NAS100 was the biggest "exposure" at 880k); `apply_marks` now joins the public `contract/detail` `contractSize` map, and the mark join runs in parallel with it. Verify live: `cargo run -p mexc --example mexc_probe` → per-position `totals` must equal the assets line's `unrealized` (it did: −8640.66 vs −8640.74), `side/pnl check` must be `0 of N disagree`, and `notional` must be quote-scale. The auto-protect batch keys its raw snapshot by `(symbol, side)`, so each hedge leg places at its own `openType`/`leverage` instead of the last row's. The audit does NOT sync (deliberate: it signs nothing) — run `mexc_futures_positions` first, or the report grades the previous snapshot; the plan text says so now |
| `mexc_futures_audit_data` returns `[{"error":"rejected (510): Requests are too frequent …","symbol":"…"}]` and the audit skips those positions | FIXED 2026-10-20 — MEXC's public kline budget is 20 requests / 2 s per IP and its limiter counts a hard window with no burst allowance, while the shared candle gate spaced requests 100 ms apart — exactly that ceiling, so a 25-symbol warm-up (the audit cap) drew 510 on the tail. 510 arrives as HTTP 200 `success:false` `code:510`, which used to classify as `Rejected` (nothing to retry on). Now: `client::RATE_LIMIT_CODE` maps it to `VenueError::RateLimited`, `candles.rs` adds a process-wide 250 ms per-IP kline gate (4 req/s) plus 2 retries honouring `Retry-After` (capped 2 s). Verify: `mexc_futures_audit_data` returns `warmed == selected` with no `warnings`, a full 1h warm-up taking ~6 s |
| Screener offer shows 1 recommendation from a hundreds-of-symbols scan | FIXED 2026-10-13. The fixed pipeline emits ONE `crypto_screener` step PER SCREEN (`screener_plan.rs::build_screener_plan`), each with its own `hits` — but the run-view offer read only the FIRST step via a `find`-style helper, so a 743-symbol run holding 401 hits across 7 steps rendered the 1 hit that happened to sit in step one. The panel now takes EVERY screener step id (`screenerRunStepIds`), fetches them in parallel and merges (`parseScreenerOffer` takes an array, sums `scanned`/`hitsTotal`, and reports the `directionless` count a neutral screen like `squeeze_watch` contributes). Replays to 29 actionable rows. Recurs → check the offer's step list length against `SELECT step_id FROM supervisor_step_results WHERE tool='crypto_screener'`: **one panel can only ever show one step's slice unless the ids are merged** |
| Screener offer shows fewer rows than the report, with no explanation | not a filter bug until ruled out: the panel drops `spot` runs (no futures trade client) and `Neutral` screens (no direction to enter on) silently by design. It now states both in the header ("N of M hits from K symbols" + a "directionless" chip) and the empty state distinguishes "the scan fired nowhere" from "everything it fired on was directionless" — check those counts first |
| Planner never leaves the core tools / `<tool-search-results>` says "catalog unavailable" | the shared catalog (Turso) is unreachable or unseeded — `[tool-catalog] local replica is EMPTY` in the log means the replica sync failed or `list_names()` came back empty, and the planner is then pinned to `PLAN_CORE_TOOLS`. Check `KAWAI_TURSO_DB_URL` resolves to the libsql URL (a leftover `http://127.0.0.1:8084` assignment in `.env` wins when the file is sourced), then probe: `cargo run --example tool_catalog_drift_check --features litert,binance,monad` → `local merged toolset: N; catalog: N`. Client token is `data_read`-only, so a `SQLITE_AUTH` here means you passed the wrong token, not that the DB is broken |
| Catalog rows exist but search returns irrelevant tools | vector space mismatch: the catalog is seeded with the **on-device LiteRT embedder** (`build_litert_embedder`, EmbeddingGemma-2 740M, 768 dims). Re-seeding with a cloud provider (`build_providers_from_env`) silently makes cosine noise — no error surfaces. Re-seed with the LiteRT path. The HF model is fetched from `main` (unpinned), so a model bump on HuggingFace breaks the space for everyone at once |
| `not authorized` / `SQLITE_AUTH` from any write against the catalog | expected for clients: the shipped token is `perm=[all tables: data_read]`. Seeding and `--prune` need the admin token (`KAWAI_TURSO_WRITE_TOKEN`). Note `turso db tokens create <db> -r` produces a token the server REJECTS (`JWT error: InvalidToken`) — mint with `-p 'all:data_read'` |

| `PRICE_ABOVE_PERCENT_BAND` / `PRICE_BELOW_PERCENT_BAND` refuses a protective order the venue would accept (CRVUSDT 2R take-profit 0.4320 vs entry 0.3740, 2026-10-20) | FIXED 2026-10-20 — the local venue guard applied `PERCENT_PRICE` to a conditional order's `triggerPrice` using the position's **entry** price as the reference. Binance's filter constrains an order's *price* against the **mark** price (BUY ≤ `markPrice·multiplierUp`, SELL ≥ `markPrice·multiplierDown`) and STOP_MARKET / TAKE_PROFIT_MARKET carry no price — triggers are governed by side + immediate-trigger (`validate_trigger`) only. The entry reference made every stop on a position >10% underwater relative to entry unplaceable, and every take-profit rung >10% above entry. Live evidence: TAKE_PROFIT_MARKET orders placed before the guard (MEGAUSDT 0.06592 with entry 0.04943, Oct 11) rest on Binance, far outside any 1.1 band. `check_venue_rules` now enforces only tradability + `LOT_SIZE`; a trigger the venue does reject still surfaces the exchange's own error |


| Every `security_scan` category returns the SAME findings (xss/sqli/auth reports identical; `testsRun` identical, e.g. 866 in every step) | NOT a UI/replay bug — `supervisor_step_results` rows are per-step distinct; the engine ignored the selection. `standalone.rs` computed `has_only_filter` but gated only ~11 of ~113 scanner dispatch sites, so always-on scanners (session_management, advanced_auth, hpp, waf_bypass, …) ran in every scan; even `security_recon` (only_modules=RECON_MODULES) came back with active-test findings. FIXED: every reportable dispatch in `crates/lonkero/src/standalone.rs` is wrapped in `scan_config.should_run_module(<canonical id>)` (ids from `modules/ids.rs`); discovery/form-collection infrastructure stays ungated (attack scanners need its params); `security_scan` now lists `RECON_MODULES` explicitly so the recon-grade baseline survives the gate (tool contract: "recon-grade discovery plus the selected attack modules"). Verify: two scans with different single categories must produce different `testsRun` AND different findings (see `security_smoke`). Dev-loop gotcha: `tauri dev` does NOT watch `crates/lonkero/**` (path dep outside `src-tauri/`), so lonkero/security-tools edits do NOT hot-reload the app — the stale binary keeps producing identical findings and looks like a failed fix; touch a file under `src-tauri/src/` (or restart `bun tauri dev`) to relaunch, and check the envelope's `modules` count (`security_scan` selects 6 RECON_MODULES + category modules = 7 for a single category; the pre-fix binary shows the bare category list) |

| Desk analyst report (news/social/fundamentals) quotes obviously wrong prices or rates (e.g. BTC news card says "$60,500 – $63,800 over the past week" while `d_data` shows $77k — 2024-era values from training memory) | the role ran with near-zero source materials and padded from memory. Check `supervisor_step_results` `d_data` output: `news.failures` rows + `news.sources` count. `failures[].error = "unknown error"` used to hide the real cause — `run_source_kind`'s failure arm read `r.text()` (the SUCCESS body, always None on error) instead of `error_message()`, so every dispatch failure flattened to "unknown error". Root cause of the news tier failing at all: the desk fetched `market_squawk_search` against `finance::all_tools()`, which Default-constructs tools and structurally cannot carry the user-bound squawk tools ("tool does not exist" every run; no `squawk.db` ever created). FIXED 2026-10-31: `fetch_news_data` takes the bound `user_id` (`DeskDataTool::with_user`), adds `NewsSquawkTool`/`NewsSquawkSearchTool` to the fetch set, runs the live `market_squawk` snapshot FIRST (it populates the history the search reads), then `market_squawk_search`; the error arm reports the real message; and `materials_block` prepends an Evidence notice (fetched totals < 200 chars) forbidding unsourced figures. Recurs → check the role's input size in `turn_log` (≈800 input tokens = no materials reached the model) and the run card for the Evidence notice |

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
  exports to Grafana — query paths in §2. Credentials are **baked**
  (obfuscated `kawai-vault/constants`), not env-gated: generation ingest +
  OTLP auth come from the vault; `OTEL_EXPORTER_OTLP_ENDPOINT`/`_HEADERS`
  env vars override the OTLP side only (dev); a build with empty vault
  entries is inert and no env var turns it on. One `glc_` token covers both
  channels. Generation/workflow export = 3 attempts with backoff; a final
  failure drops the batch LOUDLY (`tracing::error!` → Loki — alert on it,
  see `docs/GRAFANA-ALERTS.md`; dropped tokens are never billed by the
  recap). Agent roles: a NEW system prompt = a NEW role
  (`with_agent`/`reason_as`), or it collapses into `kawai-agent`.
  Short-lived processes must call
  `kawai_telemetry::shutdown()` before exit. Org slug lives in
  `~/.config/gcx/config.yaml`; refresh OAuth with `gcx cloud login` when
  Grafana calls 401.
