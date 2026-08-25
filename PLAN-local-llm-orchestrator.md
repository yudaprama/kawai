# Local-LLM Orchestrator: Lessons Learned & Open Homework

**Context.** kawai's architecture decision (2026-08-16, confirmed 2026-08-20): the
on-device Gemma 4 model (E2B / E4B, via LiteRT-LM) is the **permanent
orchestrator**. Cloud models (zai default, via `logic::remote`) are wired only as
*subagent tools* (`deep_write`, `draft_document`) for heavy synthesis — never as a
replacement for local planning/tool-routing. This document records what we learned
operating Gemma 4 as the orchestrator and the open homework that must be resolved
before we trust it for the MVP and beyond. The user's standing concern: **"I'm
afraid of Gemma 4's performance as a local orchestrator."** That fear is the
throughline of the homework below.

---

## 1. Lessons learned (established, with evidence)

**L1 — Thinking mode is a no-go.**
Evaluated via `src-tauri/examples/thinking_smoke.rs` (Gemma 4 E2B). Thinking ON
added **~4× latency** (16.8s vs 4.3s) with **no observed benefit** — no thought
tokens surfaced (`thinking_seen=false`), and file-id transcription was already
correct without it. Local default is **OFF**; the `Thinking` event exists only for
telemetry. Do not reconsider unless upstream ships a model that actually streams
reasoning through the Conversation API.

**L2 — Sampling params are already at Google's defaults; don't override blindly.**
`local-llm` builds a `ConversationConfig` and sets **no** sampler params, so the
runtime uses LiteRT-LM's C-API defaults (Gemma 4 reference = `temp=1.0,
top_p=0.95, top_k=64`). The `SamplerParams::default()` in cognee-litert-lm
(`top_k: 40`) is **never applied** because we never call `set_sampler_params`.
Conclusion: R2 ("align to Google defaults") was a no-op on inspection. Touching
sampling requires first *explicitly* constructing a `SessionConfig` + sampler — a
behavior change, not a tune-up.

**L3 — The real context ceiling is the K/V budget (32003), not "128K".**
We set `KAWAI_LLM_MAX_TOKENS` (K/V state entries). Default raised
**8192 → 16384** (R3, clamped `< 32000` so an over-ceiling env override degrades
to default instead of crashing). The LiteRT-LM magic number caps the *model's*
max sequence at **32003** — far below the 128K Gemma 4 is marketed at (that figure
is for a different runtime/rope config). Every prefill token occupies a K/V entry
**permanently**; long sessions hit the budget and trigger the overflow-reset
recovery (`logic/agent.rs:27-30`).

**L4 — Prompt-based tool calling is the structural fragility.**
LiteRT-LM's Conversation API has **no native function calling**. We declare tools
in the prompt and parse the model's text for `call:NAME{json}` (also accepting
Gemma's `<|tool_call>…<tool_call|>` wrapper and a legacy ```tool fence —
`parse_tool_call`, `agent.rs:725`). Everything rides on text parsing. The
model can emit malformed calls, drift from the protocol, or corrupt arguments.

**L5 — The session-20 corruption was this fragility, not a parser bug.**
In session 20 the model saw a real 23-char store id (`f87366129058607000-0000`)
and wrote `f7` / `f36.pdf` / `f` — classic transcription failure under prompt-based
FC. Fixed (session 21 verified) with **alias handles**: per-session `doc1`/`doc2`
masks rewritten into `office_list_files` / `knowledge_search` results and resolved
back to real ids at dispatch (`agent.rs` `alias_*`). This is a **band-aid**: it
reduces the attack surface (shorter, stable tokens) but does not make calls
structurally valid. A grammar-constrained router would.

**L6 — The hybrid cloud tier is the working quality escape hatch.**
When a remote provider is configured, `deep_write` streams one stateless cloud
completion for long-form synthesis; its result is final and bypasses local rewrite.
On cloud failure the turn degrades to local. This already exists — the question is
how often local *needs* it (which is H1/H2).

**L7 — GPU is blocked upstream.**
Gemma 4 GPU on LiteRT-LM fails (`GPU_ARTISAN` engine type deleted upstream;
Roadmap 17). We are **CPU-locked** → a hard latency ceiling on Apple Silicon and
especially on lower-end / mobile targets.

**L8 — Model size vs quality gap is real.**
MMLU-ish: E2B ~60%, E4B ~69%, 12B Unified ~77%. E2B is too weak as a default
orchestrator; E4B is the current choice; 12B is a clear quality step for machines
with 16–32GB+ (Roadmap R4, post-MVP).

**L9 — Engine swap (cactus stage-0, 2026-08-22): faster but dumber. Don't swap.**
Measured on the user's machine, same E2B weights family, `cactus run` v2.1.0 vs
our LiteRT stack: cactus Metal INT4 decodes at **57 tok/s vs 16.7** (LiteRT CPU
f16) — 3.4×, split ~1.7× engine+INT4 and ~2× Metal; TTFT 0.4–0.8s vs 2.5s; RAM
359MB. **But native tool calling lost where ours won**: identical 3 office
prompts (alias enum + regex synthesis + retrieval), LiteRT+our `call:` protocol
3/3 format-valid vs cactus `function_calls` **0/3 — empty, silently**. The INT4
model emits `tool_code print(replace_text("annual_report_2025.pdf"…))` (its own
tool name, raw filename instead of the `doc2` enum) and the engine's schema
mapping drops it. So the win is throughput (which we don't bottleneck on — heavy
synthesis already goes to `deep_write`) and the loss is exactly our core fear
(argument fidelity, L4/L5). Speed fixes the wrong problem. Revisit conditions in
H8. Also: the E4B cactus artifacts are unusable today — the HF repo publishes
`-int4` zips that the v2.1.0 CLI can't resolve (expects `-cq4`) and that lack the
`components/manifest.json` the engine requires; only E2B ships a complete bundle.

**L10 — 128K context exists off LiteRT, but prefill kills it interactively.**
cactus E2B ingested a **17,635-token prefill Successfully** (no 32003 magic;
`context_length=131072` real; 713MB engine RAM) — but at 66 tok/s prefill that is
a **267s TTFT**. Long context loads, yet is unusable for interactive turns on
either engine (LiteRT by K/V cap, cactus by prefill speed). Session compaction /
selective context stays the strategy; engine choice does not rescue long sessions.

**L11 — Needle 2 as pre-router: killed in one spike (2026-08-22).**
Tested `cactus-needle` 2.0.9 standalone (engine 14MB, ~28MB RAM, no JAX at
runtime) with our raw components office schemas (3 tools: list / search /
pdf_replace with alias enums). The grammar constraint works perfectly — every
call was schema-valid JSON, enums respected, zero malformed output — but the
semantics failed 0/4: multi-call spam (3 parallel calls for a single-file edit),
swapped arguments (find=`2026`, replacement=`"annual report"`), wrong tool
selection (pdf_replace for a retrieval question), and no multi-turn chaining.
Two structural confirmations: (1) the 45M base cannot do zero-shot tool
selection or synthesized args (regex) on office workloads → fine-tune would be
mandatory; (2) fine-tuned weights kill the confidence head (`confidence: None`)
— so the two reasons to adopt Needle cannot coexist. The confidence head itself
was honest (every failure scored ~0.000x — calibration is real), so the
pre-router *architecture* (route-by-confidence) remains a valid pattern if a
capable tiny model ever appears; Needle 2's brain is not it. Caveat on fairness:
the spike used raw JSON schemas (our integration shape), not idiomatically
documented Python decorators — but that IS the integration contract we need.

**L12 — The H1 number exists: E4B scores 19/20 (95%) on the office eval.**
Full eval run 2026-08-22 (`h1_eval.py`, 20 scenarios × 5-tool office schema:
alias transcription, regex synthesis, retrieval-mode choice, ordered merge,
filename inference, paraphrase→query, no-tool bait). **E4B passes 19/20.** Alias
handles held everywhere (the session-20 wound class never fired); regex synthesis
passed both cases (T02 date reformat, T16 currency — yesterday's literal-instead-
of-regex was variance, not a systematic weakness); ordered merge and mode
selection correct. The single failure (T10) is a *benign* class: "Who wrote
Hamlet?" → `knowledge_search` instead of answering directly (over-eager tool
use, not argument corruption). Failure taxonomy: 0 malformed calls, 0 wrong
arguments, 0 wrong aliases, 1 spurious tool call. **The standing fear now has a
number, and the number says the stack is sound.**

**L13 — 12B is not reachable on desktop CPU: both LiteRT variants are
GPU-packaged.**
`gemma-4-12B-it.litertlm` (plain) is rejected at load: "Model requires one of
[gpu] but Main backend is CPU" — the same engine-settings class as L7. The
`-web` variant loads but fails with `TF_LITE_PREFILL_DECODE not found in the
model` (WebGPU target, needs browser-shaped components). So the "just swap the
model file" upgrade path does not exist: every 12B artifact LiteRT ships assumes
a GPU backend we cannot get (L7). Bigger-model-on-desktop stays blocked until
upstream ships CPU-constrained (or unconstrained) 12B weights — or a GPU path
(L7 / Roadmap 17 / H8-cactus) lands. E2B/E4B are the only playable tiers today.

---

## 2. Open homework (must be resolved)

> These are the tasks that de-risk "Gemma 4 as orchestrator." Each needs a concrete
> answer with evidence before we declare the local tier production-ready.

**H1 — ~~Quantify orchestration quality~~ DONE 2026-08-22 (L12).**
The eval exists (`src-tauri/h1_eval.py` + `bench_litert` example): 20 fixed
office scenarios, subprocess-isolated, auto-scored (tool choice, arguments,
aliases, ordering, refusal shape). **E4B: 19/20 (95%), sole failure = one
spurious tool call (T10).** Remaining work is maintenance, not measurement:
promote the harness into a committed `agent_eval` example (see H9), grow the
scenario set when new tool categories ship, and add the T10-class persona fix.

**H2 — ~~Pick the MVP default model~~ RESOLVED 2026-08-22: E4B, by elimination
and by measurement.** E4B scores 95% on H1 (L12); E2B is the known-weaker tier
(L8); 12B is unloadable on CPU (L13). The "measured decision" is now measured.
Reopen only if upstream ships CPU-usable 12B weights or a GPU path lands.

**H3 — Tool-calling strategy: band-aid vs grammar-constrained router.**
Alias handles (L5) make prompt-based FC *reliable enough* but not *structurally
valid*. Options evaluated:
- (a) keep prompt-based + alias (current) — **chosen**;
- (b) ~~Needle 2 spike~~ **killed 2026-08-22** (L11): standalone Python spike,
  our raw components office schemas, 4 workload tests — 0/4 semantically
  correct (wrong tool, swapped args, multi-call spam), confidence head honestly
  scored every failure ~0.000x;
- (c) rig native FC if a local rig provider path exists (currently we avoid rig
   providers for the orchestrator) — unexplored, low priority while (a) holds.

**H4 — ~~Measure and budget latency~~ DONE 2026-08-23 (harness).**
End-to-end turn latency = local plan + tool exec + (local or cloud) synthesis.
`agent_eval` now reports **avg / p50 / p95** across 20 scenarios plus a budget hint
(`src-tauri/examples/agent_eval.rs:287`); `local_llm_smoke` reports **TTFT / decode tok/s**
per turn and logs the K/V budget (`local-llm/src/lib.rs:315`, `examples/local_llm_smoke.rs:29`).
Baseline (2026-08-22, E4B): decode 9.3–10.3 tok/s, TTFT 7.4–8.2s cold, load 0.4–1.2s warm.
Budget suggestion is now emitted: tool-routing turns <12s, long synthesis via `deep_write` (600s deadline,
`logic/agent.rs:104`). Remaining is periodic re-measurement, not new harness.

**H5 — ~~Validate the failover boundary~~ DONE 2026-08-23 (regression).**
The hybrid failover boundary is "first text token handed to consumer" (Roadmap 5).
Covered by unit tests `failover_boundary_empty_stream_marks_unhealthy` and
`failover_boundary_yielded_token_commits_provider` (`src-tauri/src/logic/remote.rs:594`),
exercising the `!yielded_any` empty-completion branch and the `!yielded_any && failover_worthy`
guard (`remote.rs:387`). Gated by `cargo test --features litert,office --lib` on all three
platforms (`ci.yml` + `kv-sweep.yml` reuse the same gate). Manual cloud smoke (`remote_smoke`,
`draft_smoke`) remains for anecdotal load.

**H6 — Mobile path is unsolved.**
LiteRT-LM C lib is not built for mobile (Roadmap 13); 3.4GB E4B will not fit on a
phone. The realistic on-device mobile orchestrator is a tiny router-class model
or a much smaller Gemma variant — but Needle 2 is now ruled out as that router
(L11); watch for a capable successor rather than forcing it.

**H7 — Push the K/V budget toward the 32003 ceiling (harness DONE; CI low-RAM floor measured
2026-08-23; high-budget run + default pick pending).**
Harness is committed: `local-llm/src/lib.rs:315` logs `max_tokens` on load,
`src-tauri/examples/kv_sweep.rs` loops budgets with TTFT/decode-phase tok/s per budget,
`scripts/kv_sweep.sh` wraps `/usr/bin/time -l` for peak RSS (isolated per process),
`.github/workflows/kv-sweep.yml` sweeps 8192/12288/16384 weekly (Mon 03:00 UTC) + manual
dispatch (`ci.yml` stays fast per-PR). CI floor on the 14 GB runner (2026-08-23): **8192 OK**
(footprint 6.3 GB), **12288 OK** (13.2 GB), **16384 OK** (22.8 GB); RSS stays flat ~3.0–3.5 GB
and TTFT ~11.6 s is budget-invariant. **24576 was jetsam-killed** (footprint 46 GB > runner
RAM) so budgets above 16384 belong on target hardware. Marginal footprint cost is superlinear:
~1.6 MiB/slot (8192→12288), ~2.2 MiB/slot (12288→16384) — rule of thumb **~2 MB per K/V slot,
allocated upfront at conversation creation** → the 32003 ceiling implies a ~60 GB-class
machine; even the current 16384 default needs ~23 GB. Remaining: one local run on target
hardware (`bash scripts/kv_sweep.sh <model> 24576,31999`) and decide whether the default
moves above 16384 or stays put for min-spec headroom — that decision directly reduces overflow
resets (L3). Must be measured, not guessed.

**H8 — ~~Revisit cactus~~ CONCLUDED 2026-08-22 (L9). No cactus integration.**
Cactus decodes 3.4× faster but fails tool calling 0/3 (LiteRT 3/3) — wrong
tool names, schema mapping drops output silently. Speed is the wrong
optimization: heavy synthesis already routes to `deep_write`. The only
conditions that could reopen this are ALL of: (a) upstream ships a working
E4B bundle (current `-int4` zips are broken), (b) cactus native FC passes
office-style tools, (c) INT4 quality matches f16 on our eval. None are met,
none are pursued. The integration path is closed; upstream movement is
watched passively, not acted on.

**H9 — ~~Land the eval as a permanent gate~~ DONE 2026-08-22.**
`src-tauri/examples/agent_eval.rs` is committed: the 20-scenario set, tool
schema, and scorer live in the example (one model load, `reset_conversation`
between scenarios, first-`call:`-line parsing mirroring the agent loop).
**Baseline now 20/20 (100%)** — the T10 spurious-call class is fixed by a
persona rule ("general-knowledge questions unrelated to the user's files:
answer directly, no tool"), applied to both `OFFICE_PERSONA` (`agent.rs`) and
the eval's protocol prompt. Run: `cargo run --release --example agent_eval
--features litert,office -- <model.litertlm>`. Rule of use: re-run after any
persona / tool-surface change in `agent.rs` — the score must not regress.
Still open (product work, gated by this eval): the regex-preset tool-surface
idea (move regex synthesis out of the model: literal find/replace + enum
presets expanded in Rust).

---

## 3. Suggested order

1. ~~**H1**~~ **DONE (L12), now **20/20** after the T10 persona fix. ~~H9~~
   **DONE** — the eval is a committed gate (`agent_eval.rs`). Follow-up:
   regex presets.
2. ~~**H2 + H7**~~ H2 **DONE** (E4B, L12/L13). **H7 harness DONE 2026-08-23**
   (`kv_sweep` + `kv-sweep.yml` weekly); CI floor measured same day — 8192/16384
   fit a 14GB machine, 24576 does not (~2 MB K/V per slot). Remaining: local
   24576/31999 run on target hardware, then pick the default budget.
3. ~~**H4 + H5**~~ **DONE 2026-08-23** — H4 harness reports p50/p95/TTFT, H5 failover regression gated in CI (MVP readiness).
4. **H3** — resolved by measurement: Needle killed (L11), option (a) stands on
   19/20 eval evidence; revisit only if the eval later shows real malformed-call
   problems.
5. **H6** — mobile, end-state track.
6. ~~**H8**~~ **CONCLUDED (L9)** — cactus faster but tool calling 0/3; closed.

**Bottom line:** the fear is now a number, and the number is perfect: **E4B
runs the office workload at 20/20 after the T10 persona fix, with zero
argument-corruption failures** (L12, H9). The orchestrator question is settled
for MVP — LiteRT + prompt-based FC + alias handles + hybrid cloud offload, E4B
as the model (H2), cactus closed (L9/H8), no pre-router (L11), no 12B escape
hatch (L13). What remains is one mechanical measurement (H7 budget pick) and
the regex-preset tool-surface polish.
