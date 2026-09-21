# PLAN — CLI tools (`cli_run`): the user's machine as an agent toolset

Status: implemented (v1).

## Problem

The supervisor can only plan against tools registered in the merged
`ToolSet` (office, analytics, binance, …). The user's machine is full of
capable CLIs (`ffmpeg`, `jq`, `pandoc`, `gh`, …) the agent can neither see
nor run. The set of installed CLIs is **per-device state** — it differs for
every user — so none of the existing global machinery fits:

- **The Turso tool catalog is the wrong layer.** It is global, client
  read-only, and seeded once from the dev machine; it cannot represent
  "this device has `ffmpeg`, that one doesn't", and seeding device-specific
  rows would poison the shared curation.
- **One `AgentTool` per CLI does not scale.** Hundreds of binaries →
  registry bloat, validator churn, and (if ever seeded) generic-description
  crowding in the shared catalog (the measured failure mode the relative-
  cosine gate exists for).

## Design

Two pieces, both fully local (works offline; zero Turso contact):

### 1. Inventory scan (per-device, cached per process)

`kawai_cli::inventory()` scans, once per process:

- every dir on `PATH`, **plus** the well-known GUI-landmine dirs macOS
  launchd strips from GUI apps' PATH: `/opt/homebrew/bin`,
  `/usr/local/bin`, `/usr/local/sbin`, `~/.cargo/bin`, `~/bin`,
  `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`;
- keeps only executable files, dedup by binary name (PATH order wins);
- drops denylisted binaries entirely (shells, process/system control,
  destructive: `rm`, `dd`, `mkfs*`, `shutdown`, `sudo`, …) — they are never
  registered, never listed, never executable via the tool;
- drops noise (dotfiles, `[`, …) so the prompt block stays signal.

A small static enrichment map (hardcoded, ~40 popular CLIs) gives the block
one-line descriptions for common tools; everything else is listed by name —
frontier models already know popular CLIs' semantics, and syntax is the
loop's job (below).

### 2. One executor tool with a self-correcting loop (`data_query_nl` pattern)

`cli_run` is ONE tool in `crates/toolsets/cli` (`kawai-cli`), added to every
agent toolset via `agent_registry::add_runtime_tools` (cross-cutting, like
`memory_search`) when the inventory is non-empty:

```json
{ "command": "ffmpeg", "args": ["-i","in.mov","out.mp4"], "intent": "…", "stdin": "…", "cwd": "…" }
```

- **Fast path**: `args` given → execute once, return. Zero LLM calls.
- **Loop mode** (intent given, or fast path failed with intent present):
  deadline-based corrective loop — `reason_in` writes argv JSON (grounded
  with a `--help` excerpt captured internally on round 1), the tool executes
  it deterministically, on failure the exit code + stderr go back to the
  model until success or the budget runs out. Budget =
  `kawai_tools::deadline::effective_budget(180s)` — the same cooperative
  step-deadline the NL data tools read, so the tool returns a structured
  error instead of being hard-killed into an opaque timeout.
- **No answer layer**: stdout/stderr are deterministic artifacts — simpler
  than `data_query_nl`.
- `requires_confirmation = true` — the gate covers the WHOLE loop; the
  prompt shows `command` + `intent`.
- **Binary pinned per step**: the loop may only vary argv of the confirmed
  binary (resolved to the absolute path found at scan time — no PATH
  re-resolution between confirm and exec). Switching binaries = step
  failure → planner repair → a new step gets its own confirmation.
- Denylist is enforced at scan time (never in inventory ⇒ never
  executable); args ride as an argv array — **no shell**, no interpolation.
- Output: `{command, argv, exitCode, stdout, stderr, attempts, durationMs}`
  with stdout head-capped / stderr tail-capped.

### Planner visibility (no catalog, no search rounds)

- `PLAN_CORE_TOOLS` += `cli_run` — core tools render from the LOCAL registry
  (`registry.catalog_lines_for`), so the planner always sees the tool's
  schema without a Turso search.
- A bounded `<cli-tools>` block (`kawai_cli::prompt_block()`) rides the
  planner system prompt listing the installed commands — the planner sees
  the complete capability space directly; when the inventory exceeds the
  ~4k cap, described CLIs sort first and the tail is counted, not hidden
  silently.
- Planner guidance mirrors the `data_query_nl` bullet: default to `intent`
  (self-corrects, allow 1–2 min), pass exact `args` only when confident.

## Non-goals / deferred

- **Per-device local catalog** (libSQL + FTS5/embeddings with a fused
  search arm in `run_tool_search`): only if real-world inventories prove
  too big for the capped block. The Turso catalog stays untouched either way.
- LLM batch-description of unknown binaries (cached in local SQLite) — the
  static map covers the common case.
- Auto-approved read-only classification: v1 confirms every invocation.

## Wiring map

| Touch | Change |
|---|---|
| `crates/toolsets/cli` | new crate: scan, denylist, enrichment, `prompt_block`, `CliRunTool` |
| `kawai-tools` | `pub mod deadline` (moved from analytics-tools; one `task_local` key) |
| `crates/toolsets/analytics-tools` | re-exports `kawai_tools::deadline` (paths unchanged) |
| `agent_registry.rs` | `add_runtime_tools` adds `cli_run` when inventory non-empty |
| `supervisor.rs` | `PLAN_CORE_TOOLS` += `cli_run`; `plan_loop_system_prompt` takes the `<cli-tools>` block |
| `catalog_composition.rs` | `PER_DEVICE_TOOLS = ["cli_run"]` excluded from the Turso seed/drift composition |
| docs | AGENTS.md toolsets tree + a Shipped bullet |

## Verification

- `cargo check` / `--features web` / kawai-web matrix stays green.
- Unit tests: scan (denylist, dedup, exec-bit, noise skip), argv parsing,
  block cap/prioritization, exec happy-path (`/bin/echo`, `#[cfg(unix)]`).
- Catalog composition: `cli_run` absent from `merged_definitions()` —
  locked by the existing exclusion test.
