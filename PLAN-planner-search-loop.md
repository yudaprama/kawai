# PLAN-planner-search-loop — benchmark & design record

Status: **implemented** (mode A — no full-catalog fallback). This document
records the design contract and the measured benchmark that justified the
current defaults. History lives here, not in AGENTS.md.

## Current architecture (what shipped)

`plan_task` (`src-tauri/src/supervisor.rs`) no longer pastes a tool catalog
into the planner prompt. The planner runs a **bounded search loop**:

```
Round 0    LLM sees: goal + <user-context> (persona/memories/skills)
           + core tool whitelist + protocol. No catalog.
Round 0..2 LLM replies {"action":"search","queries":[≤3]} → executed against
           the Turso tool catalog (embedded replica; hybrid vector+BM25+RRF),
           results appended to materials (12k char cap, dedup across rounds).
Final      LLM replies {"goal","steps":[…]} → parse_supervisor_plan validates
           against the FULL ToolRegistry (advisory gap is intentional).
Repairs    1 corrective round on validation failure (validator message +
           fuzzy name suggestions). Hard cap: 6 LLM calls total.
Core set   web_search, memory_search, artifact_recall, deep_write,
           draft_document — always visible (retrieval misses cross-cutting
           tools disproportionately; measured, see Benchmark below).
Fallback   NONE (mode A, deliberate). Catalog unavailable ⇒ searches report
           empty; the planner plans from the core set or fails validation.
Backends   Remote pool (default) · `KAWAI_PLANNER_LLM=local` → on-device
           Gemma via LiteRT (dev/test seam; each round is a fresh one-shot).
```

Supporting pieces: `kawai-tool-catalog` (Turso embedded-replica store, seeded
via `src-tauri/examples/seed_tool_catalog.rs`), `ToolRegistry::narrowed`
(advisory subset, used by checks), probes `tool_search_probe`,
`tool_catalog_narrow_check`, `plan_loop_probe`.

## Benchmark — same goal, both backends

Goal: *"buatkan deck presentasi penjualan dari data analytics"* (catalog = 32
tools, invisible to the planner). Run on the dev machine, 2026-02.

### Remote pool (chosen default)

**250.2 s · 5,361 in / 14,602 out tokens · 8 steps, all dispatchable**

```
s1 office_list_files   ← correct first move
s2 data_schema
s3 data_query_nl (KPIs)        ┐ parallel
s4 data_query_nl (monthly)     ├── all depend on s2
s5 data_query_nl (top-10)      ┘
s6 data_chart
s7 office_create_deck  (waits s3–s6)
s8 office_export_deck
```

### Local Gemma 4 (`KAWAI_PLANNER_LLM=local`) — NOT the default

**124.6 s (earlier run: 101.4 s) · 6 steps, all dispatchable**

```
s1 web_search          ← quirk: used to "find local data files"
s2 data_schema
s3 data_query_nl (KPIs)
s4 plan_task           ← quirk: recursive planner-as-tool step
s5 office_create_deck
s6 office_export_deck
```

Second local data point — *"cari berita terbaru tentang AI di internet lalu
buatkan presentasinya"*: **59.6 s · 4 steps** (`web_search → draft_document →
deep_write → draft_document`), clean and correct — including `web_search`,
which **single-shot hybrid search failed to surface** (see probe results);
the multi-round loop found it. This validated the original tool-search thesis.

### Decision recorded

- **Remote is the default and the only supported production path.** Planning
  reliability outranks cost/latency: local produced 2 semantic quirks in its
  best plan (misused `web_search`, recursive `plan_task`); remote produced
  the best plan observed from this planner, period.
- Local stays wired as the `KAWAI_PLANNER_LLM=local` seam (offline/privacy
  experiments), not a supported default.

## Single-shot search recall (why the loop exists)

`tool_search_probe`, top-5 per query, catalog-as-seeded:

| Query | Target surfaced? |
|---|---|
| deck presentasi dari data analytics | ✅ (with noise) |
| gabung + pisahkan PDF | ✅ |
| RSI/MACD bitcoin | ⚠️ `data_ta` #1, rest noise |
| cari berita di internet | ❌ `web_search` absent |
| ingat preferensi rapat | ❌ memory tools absent |
| tulis artikel panjang | ❌ `deep_write` absent |

≈40–60% recall → multi-round LLM-driven search + core whitelist is mandatory;
single-query narrowing is not sufficient.

## Latency analysis & backlog (remote, 250 s)

Dominant cost: **14.6k output tokens** across 2–4 calls (verbose task
descriptions + protocol JSON + search rounds). At typical provider speeds
that alone is 3–4 minutes. The loop's sequential rounds cannot parallelize.

### Re-benchmark after optimization (2026-02, same goal, remote pool)

Applied: optional `task` ≤80 chars (arguments stay complete), per-call
output cap 2.5k for planner calls (`with_output_cap`), search rounds 3 → 2,
winning-provider logged per round.

**60.2 s · 4,107 in / 2,956 out tokens (5× less output) · 7 steps, all
dispatchable · 3 rounds, all served by `zai`**

```
s1 office_list_files
s2 data_schema
s3 data_query_nl (KPI)          ┐ parallel
s4 data_chart (line, monthly)   ├── all depend on s2
s5 data_chart (bar, per-product)┘
s6 office_create_deck  (waits s3–s5)
s7 office_export_deck
```

250 s → **60 s (4.2×)** with plan quality preserved (structure on par with
the baseline; charts split line+bar). Output tokens ÷5.

Original backlog (for reference):

1. **Brevity directive** — task descriptions ≤120 chars in the protocol
   prompt (validator still allows 4000, but brevity is what is asked).
   Expected: output tokens ÷3 → ~90–120 s.
2. **Lower output cap for planner calls** — `KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS`
   is global; a planner-specific cap (e.g. 2k/call) bounds worst-case rounds.
3. ~~Search rounds 3 → 2~~ **DONE** — multi-query per round already covers
   most needs; every benchmark goal resolved in ≤1 effective round.
4. **Fast-model slot for the planner** — the planner does not need the
   frontier model; a pool override ordering a fast candidate first for
   `plan_task` only.

Not worth pursuing: parallelizing rounds (inherently sequential), local as
default (reliability — decision recorded above).

## Known quirks / follow-ups

- `TaskStep.agent_id` now defaults to empty (LLM plans omit it); safe —
  tool-dispatched steps never dispatch by agent.
- `execute_batch` must never be used over the replica connection for DDL
  containing triggers (Hrana splits on `;` inside trigger bodies). All DDL in
  `kawai-tool-catalog` is statement-per-`execute`.
- Read-only client tokens cannot run `CREATE TABLE IF NOT EXISTS` (blocked as
  a write); `Catalog::search` creates schema only when the table is missing,
  and FTS setup is attempted once per process.
- Seeded descriptions are the generated tools' own text; description
  enrichment (LLM pass at seeding) is the top lever if single-search recall
  ever needs to improve.
