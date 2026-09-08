# Plan — Analysis Desk: adopt the TradingAgents UX as kawai's primary surface

Status: **SUPERSEDED by `PLAN-workbench.md`** — kept only as a future DOMAIN
pack (the fixed trading-desk pipeline), not the product direction.

Reference: `./TradingAgents` (TauricResearch). UX contract extracted from source —
`tradingagents/graph/setup.py` (fixed pipeline), `graph/analyst_execution.py`
(per-analyst wall-time tracking), `cli/main.py` (`REPORT_SECTIONS` state model,
Rich Live panel).

## Why this fits kawai now

Every primitive the desk needs already exists:

| TradingAgents need | kawai primitive |
|---|---|
| Market data per analyst | `get_stock_price/history/detail/fundamentals/financials/news/sector/macro/insider` (generated finance tools) |
| Social/news sentiment | `stock_sentiment`, `stock_social_feed`, `get_reddit_posts`, `get_global_news`, `trending_stocks` |
| Technicals | `binance_ta_analyze`, `data_ta` |
| Agent roles (LLM per role) | `remote_llm` pool (quick roles = small-cap call, deep roles = synthesis-cap call) |
| Pipeline execution + retries + waves | `kawai-router` scheduler on a **fixed** TaskPlan — no planner, no silent gap |
| Reports as deliverables | artifact store (`supervisor_step_results`, office store) + `emitOpenPreview` |
| Progress events | `SupervisorEvent` streaming (Channel + SSE) |

## UX contract (from source, verbatim behavior)

- **Input form**: ticker, trade date, analyst selection (`market|social|news|fundamentals`,
  default all 4), research depth (shallow/medium/deep → debate rounds).
- **Fixed pipeline** (never planned): selected analysts run in parallel →
  Bull + Bear debate (N rounds per depth) → Research Manager verdict →
  Trader investment plan → 3 risk personas debate → Risk Manager →
  Portfolio Manager final decision.
- **Panel state model** (`REPORT_SECTIONS`): each report section is
  `pending → running (spinner, live preview) → completed (see report)`.
  Section completion = its finalizing agent finished.
- **Three-pane workbench** (confirmed from the reference web app's DOM):
  - **Left rail** — progress: `Analyzing <TICKER> | Duration: mm:ss`,
    collapsible groups *Analyst Agents / Research Agents / Trading Desk / Risk
    Management Agents / Final Verdict*, per-agent row = name + status +
    `see report`.
  - **Center** — report viewer: recommendation card (decision verb + as-of
    date) → full markdown report (prose) → `AGENT REPORTS` switcher grid →
    post-run actions (analyze another / history).
  - **Right rail** — `Analysis Configuration` (date, analyst team, research
    depth shallow/medium/deep, quick+deep LLM; locked during/after the run)
    above `Messages & Tools`: a chronological event timeline per agent —
    `Reasoning` rows (model, tokens in/out) and `Tool` rows (tool name + args).
- **Deliverables**: per-agent report documents + one final decision card
  (BUY/SELL/HOLD, confidence, rationale). Reports are first-class artifacts
  (viewable, persisted per analysis run).

## Architecture

### Backend — one new op, zero changes to existing ops

```
POST /api/run_analysis_desk   +  #[tauri::command] run_analysis_desk
  args: ticker, tradeDate, analysts: Vec<String>, depth
  returns: stream<DeskEvent>            (both wrappers, streaming like
                                         execute_supervisor_plan)
```

- Builds a **fixed TaskPlan** from the selected analysts (waves: analysts ∥,
  bull+bear ∥, research_manager, trader, risk×3 ∥, risk_manager, pm) and
  executes it through the **existing scheduler + registry dispatch** — retries,
  timeouts, cancellation, artifacts all inherited.
- Each agent role = a step whose dispatcher wraps `remote_llm` with a
  role prompt (ported from `tradingagents/agents/{analysts,researchers,trader,risk_mgmt,managers}`)
  + the matching finance tools as materials (tool results fetched inline by the
  step's sub-dispatch, same as today's toolset steps).
- New `DeskEvent` (mirrors SupervisorEvent shape, plus):
  `deskStarted {ticker, sections}` · `sectionStarted {section}` ·
  `sectionDelta {section, text}` (live report growth) · `sectionCompleted {section}` ·
  `agentToolCall {section, tool, args}` · `agentLlmUsage {section, model, tokensIn, tokensOut}`
  (the Messages & Tools timeline) · `deskCompleted {decision}` · `deskFailed {error}`.
- Reports persist as artifacts keyed by `desk-<ticker>-<date>` so history can
  replay a run (same pattern as `supervisor_step_results`).

### Frontend — new Desk surface (home), chat demoted

- New route/surface `Analysis Desk` (rail entry, default view): the form lives
  in the right rail; on run, the **two-pane workbench** (per the contract
  above): left progress rail (scrollable), center report viewer (recommendation
  card + markdown + report switcher grid), right config (locked) + Messages &
  Tools timeline. Theme-token styling of the terminal look: mono type,
  `primary` accent, per-state icons — the reference's *structure*, not its
  hardcoded `#42DCA3`.
- Theme-token styling of the terminal look: mono type, `primary` accent,
  per-state icons — the reference's *structure*, not its hardcoded `#42DCA3`.
- Chat: demoted to a rail entry (kept for general goals like PDF summarization).
  The supervisor plan card work (this week) stays as-is inside chat.

## Stages

1. **S1 — backend pipeline**: role prompts ported + fixed TaskPlan builder +
   `run_analysis_desk` (both wrappers) + `DeskEvent` + persistence. Verify via
   a headless example (like `remote_smoke`) against real tools.
2. **S2 — desk UI**: surface + form + progress panel + report viewer (split
   pane), wired to DeskEvent stream.
3. **S3 — polish**: history replay of past runs, decision card export
   (markdown/pdf via existing office tools), reflection memory (TradingAgents'
   post-run lessons) if wanted.

## Open decisions (need your call before S1)

1. **LLM depth mapping**: quick roles → cheapest pool candidate, deep roles →
   best candidate? (TradingAgents uses two tiers.) Default: quick = first
   healthy provider, deep = provider after a `deep_write`-style synthesis cap.
2. **Live report growth** (`sectionDelta`): ship in S2, or only
   section-level status first (cheaper, still matches the reference CLI)?
   The tool/reasoning timeline is NOT optional — it is core to the reference
   UX and requires the two timeline events above.
3. **Chat**: demote to rail entry (recommended) or hide entirely in S2?

## Verification

- Headless smoke: `run_analysis_desk` on a real ticker end-to-end, all sections
  complete, reports persisted, decision card present.
- UI: states matrix (form → running per-section spinners/live growth →
  completed see-report → failed section → cancel mid-desk).
- Regression: chat supervisor flow untouched (its own tests + manual pass).
