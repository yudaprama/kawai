# AGENTS.md — agent guide for kawai

Read this before touching the code. Full design lives in `ARCHITECTURE.md`.
This file is the operational rulebook.

## What this project is

**Product: an AI agents app.** Users pick from a catalog of specialized agents (finance, knowledge, weather, …); each agent is an LLM persona with a curated toolset assembled from `kawai_tools::ToolSet` registries (`kawai_tools::AgentTool` implementations; generated catalogs under `crates/generated-tools/`, per-category `toolset_for(names)`). UI: three-pane layout (left sidebar = agent list, center = active agent's chat/content, right sidebar = sessions of the selected agent), dark theme.

Desktop/mobile app (Tauri), with a standalone web server binary.
**End state: desktop + mobile + web from one core. Current phase: MVP, desktop-first — see "Current phase" below.**

- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4 (`frontend/`, alias `@/` → `frontend/src`). UI components vendored from the `web/` SPA (`ai-elements/`, `ui/`, `lib/streamdown/`). NO ai-sdk — `lib/ai-types.ts` is a type-only local shim of the `UIMessage`/parts shapes; streaming is raw Tauri `Channel` mapped by `hooks/use-local-chat.ts`.
- **Auth**: remote email+password accounts via the kawai auth worker (Cloudflare, `KAWAI_WORKER_URL`). Passwords never travel — the client derives a credential from a server salt plus the vault encoder, and a successful sign-in returns an Ed25519 bearer (7 days): web carries it in a `kawai_session` HttpOnly cookie, desktop persists it and auto-restores on launch. Sign-up verifies email ownership with a 6-digit code. The React auth UI lives in `frontend/src/features/auth/`.
- **Backend**: Rust. Single core logic, two thin transport wrappers.
- **Transport**: Tauri `Channel`+`invoke` (desktop/mobile); HTTP `fetch`+SSE (web — backend only, no web frontend).
- **LLM (on-device)**: LiteRT-LM via `cognee-litert-lm` (path dep, vendored at `cognee-litert-lm/vendor/LiteRT-LM` = upstream `google-ai-edge` main). Behind the `litert` cargo feature. Gemma 4 / Qwen `.litertlm` verified streaming on macOS arm64 CPU.
- **LLM (remote)**: no LLM SDK — the hybrid tier's cloud client is hand-written (`crates/foundation/remote-llm`): a reqwest OpenAI-compatible SSE client (`chat/completions` streaming, reasoning deltas, terminal usage) over a hardcoded provider pool (gateway-zai → gateway-deepseek → gateway-venice → openrouter), keys from kawai-vault. **Decision (2026-08-16): local Gemma 4 via LiteRT-LM is the orchestrator** — no *replacement* remote provider planned. **Updated 2026-08-20: the hybrid cloud-subagent tier is now wired** — heavy synthesis delegates to cloud subagent *tools* (`deep_write`, `draft_document`) via prompt-based tool calling whenever a remote LLM is configured (default `zai`, key from kawai-vault; `crates/foundation/remote-llm` + config block below). Toolsets are usable standalone (definitions + dispatch); the on-device tier (`local_chat`) runs on local Gemma 4 with prompt-based tool calling (the LiteRT-LM Conversation API has no native function calling). Remote providers are optional configuration (see Roadmap 5 ✅), not a requirement.
- **DB**: local SQLite via `libsql` crate (desktop MVP). Post-MVP: sqld for multi-device sync.
- **Appearance**: two orthogonal layers — the light/dark/system *mode* (`hooks/use-theme.ts`, toggled on `<html>.dark`) and the *color palette* (`lib/themes.ts`: a palette is a set of shadcn semantic tokens applied as inline custom properties on `<html>`). Bundled: `mono` (the `index.css` values themselves) + `vekis`. Users add their own from the account dropdown → **Color theme** (`features/agents/theme-picker.tsx`) by pasting a tweakcn theme link (`https://tweakcn.com/r/themes/<id>`) or a shadcn preset name (`zinc`, `stone`, …) — both registries serve CORS JSON; imports persist in localStorage, and the active palette is snapshotted so the inline script in `index.html` repaints it before first paint.

## Current phase: MVP (desktop-first)

Short-term focus is a **desktop MVP** — macOS, Linux and Windows are all built and released by CI (`release.yml`: `build-macos`/`build-linux`/`build-windows`). The end state is unchanged — desktop + mobile + web from one core — so this phase defers *work*, never *architecture*. The invariants below are exactly what keeps mobile/web cheap later; they all stay law during MVP.

**MVP scope (work only these):**
- Desktop apps (Tauri, feature `litert` — macOS/Linux/Windows): on-device LLM chat (LiteRT-M), chat history in local SQLite, remote email+password auth.
- Chat UI (React): session sidebar with period grouping, streaming conversation, tool call cards, thinking toggle.
- Remaining MVP gaps, in order (details in Roadmap):
  1. Chat history persistence — ✅ Done 2026-08-16 (sessions + messages in SQLite).
  2. Distributable build — ✅ Done 2026-08-17 (litert dylibs bundled into .app).
   3. `local_llm_smoke` streaming regression gate — ✅ Done 2026-08-20 (fixture swapped 2026-10-25: the smoke now runs the PRODUCTION model, litert-community/gemma-4-E4B-it · 3.5 GB, verified streaming+turn-2 locally): `.github/workflows/ci.yml` runs `local_llm_smoke` (E4B fixture, cached) + `remote_smoke` + `draft_smoke` on a macos runner that first bazel-builds the LiteRT dylib; the `agent_eval` quality suites run as three parallel jobs in `.github/workflows/evals.yml` — `office-eval` (gate 19/20), `analytics-eval` (16/18) and `screener-eval` (market-structure vocabulary, 8/10; a provisional floor to tighten once CI shows headroom) — in parallel with ci and the release build. The harness also carries `EVAL_SUITE=accounting`, runnable on demand (`cargo run --release --example agent_eval --features litert,office -- models/gemma-4-E4B-it.litertlm`), not CI-gated.

**Deferred — do NOT start without the user asking (tracked in Roadmap):**
- Mobile LLM bazel builds + mobile UI; web frontend; LoRA; GPU/Metal; production hardening. (The agent tier — the `kawai_tools::AgentTool` tool seam, the three-pane catalog UI, and the hybrid cloud-subagent delegation — shipped 2026-08-20; see Roadmap 5 ✅.)
- Prod auth (deep-link) and keychain session persistence are the *first post-MVP milestones* — required before any public release, not part of MVP.

**Still mandatory during MVP (end-state insurance, all cheap):**
- Every new op still gets BOTH wrappers (`commands.rs` + `web.rs`) — this is what keeps web/mobile near-free later.
- `cargo check --features web` stays green for every change; mobile checks whenever shared code changes (`logic.rs`, `logic/local_auth.rs`, shared deps).
- Identity stays resolved at the transport edge (`user_id` as first arg into `logic.rs`).
- Auth stays server-verified: the session credential is only resolved through the auth worker; the client never trusts a locally claimed identity.

## Non-negotiable invariants

1. **`logic.rs` is pure.** Never import `tauri`, `axum`, or any transport type there. It owns business logic and returns `T` or `impl Stream<Item = Event>`.
2. **Two thin wrappers per operation.** One `#[tauri::command]` in `commands.rs`, one Axum route in `web.rs`. Both call the same `logic.rs` fn. No business logic in wrappers.
3. **One operation = one snake_case string**, used identically for: the Rust fn name, the invoke name, and the URL path (`POST /api/<name>`). Tauri uses the fn name **verbatim** (no kebab/camel conversion). Arguments are camelCase on the JS side, mapping to snake_case Rust params.
4. **Frontend uses the `@tauri-apps/api` npm package** (`invoke` / `Channel` from `@tauri-apps/api/core`). The React app is bundled by Vite (`frontend/` → `dist/`, `frontendDist: "../dist"`); never reference `window.__TAURI__` in new code.
5. **No AI SDK.** The chat state is produced by `hooks/use-local-chat.ts` from raw Tauri stream events; the UIMessage/part shapes in `lib/ai-types.ts` are a LOCAL type contract only (field names stay AI-SDK-v5-compatible so the vendored ai-elements components work unmodified). Never add a runtime dep on `ai` / `@ai-sdk/*`.
6. **Web deps stay gated.** `axum`/`tower-http` are `optional`, behind the `web` Cargo feature. The `web` module is `#[cfg(feature = "web")]`. The `kawai-web` binary has `required-features = ["web"]`. Never make axum a non-optional dep — it must stay out of desktop/mobile binaries.
7. **Events.** `#[serde(tag = "type")]` in `logic.rs`; frontend reads `event.type` at runtime. Terminal variants are `finished` / `error`. The frontend mirror of the event union lives in `hooks/use-local-chat.ts` (`LocalChatEvent`) — update BOTH sides when adding a variant (plus `agent.rs` matches on it too).
8. **Identity is resolved at the transport edge, not in `logic.rs`.** Wrappers verify the token and pass `user_id` (`claims.sub`) into `logic.rs` fns as the first param. The frontend NEVER sends `user_id`. `auth.rs` is pure (no tauri/axum): it does backend verification.
9. **DB builder selection is `cfg`-gated in `logic.rs`, not branched on a transport type.** `#[cfg(feature = "web")]` → remote client; `#[cfg(not(feature = "web"))]` → local SQLite. Keeps `logic.rs` pure.
10. **Vendored components stay in sync with the shim.** `components/ai-elements/*`, `components/ui/*`, `lib/streamdown/` come from the `web/` SPA. When pulling updates from `web/`, re-run the same trims: `ai` imports → `@/lib/ai-types`, strip `react-i18next`, no `@/platform` beyond the slim local adapter (`src/platform/`), no Lexical, no `@xyflow`, no `tokenlens`.
11. **Third-party licence questions are settled — do not raise them.** The licensing of every vendored and adopted dependency (including markra's `packages/editor` + `packages/editor-react`, the `web/` SPA components, `pdf_oxide`, `office_oxide`, LiteRT-LM) has already been decided and accepted. Never re-litigate it, never flag it as a blocker, never add a licence caveat to a plan, doc, or commit message, and never ask which licence to pick. Judge adoption on engineering merit only: duplication, reuse, bundle size, and verification.

## Commands

Package manager is **bun** (not npm/yarn).

```sh
# Frontend (React, Vite) — dev server on :1420 (Tauri devUrl)
bun run dev            # from kawai/ (vite, root=frontend/)
bun run build          # tsc -b && vite build → dist/
bun run typecheck      # tsc -b --force

# Desktop (Tauri) — the `tauri` npm script is wrapped by scripts/tauri.sh.
# `dev` = on-device LLM stack: litert + binance + accounting + security
# features +
# native/ rpath + profraw off (needs the Bazel-built
# dylibs; run bundle:litert once).
# `build` and everything else pass through unchanged.
bun tauri dev
bun tauri build

# Android (Tauri) — SDK/NDK come from the .env "Android build" block
# (scripts/tauri.sh reads it; no manual export). Fallback when the key is
# absent: discovery over ~/Library/Android/sdk, homebrew's
# android-commandlinetools, $HOME/Android/Sdk, then newest $ANDROID_HOME/ndk/*.
# Generated project: src-tauri/gen/android (applicationId pro.kawai.app,
# minSdk 24). Android targets are aarch64 only — `litert` ships there and the
# LiteRT-LM C library exists for android_arm64 only. The release workflow
# bazel-builds it and stages it into jniLibs via
# scripts/stage-litert-android.sh; a local APK build needs the same two steps
# first (see the script header).
bun run tauri:android dev              # dev ke device/emulator (adb devices)
bun run tauri:android:apk               # debug APK per-ABI (aarch64)
bun run tauri:android build             # release APK + AAB (unsigned)
# Alias tanpa prefix: `bun tauri android <subcommand>` — sama saja.

# Install + inspect a locally built debug APK:
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat | grep -aE "kawai|RustWebView|chromium"       # live: Rust stderr + JS console

# The app also mirrors all of it to a persistent file in its sandbox, which
# survives the app dying (logcat does not). Debug builds only:
adb exec-out run-as pro.kawai.app cat files/logs/app.log > /tmp/kawai-android.log
tail -n 100 /tmp/kawai-android.log
adb shell am start -n pro.kawai.app/.MainActivity

# No emulator/device? One-time AVD (arm64 image; x86_64 is NOT installed):
avdmanager create avd -n kawai_test -k "system-images;android-34;google_apis_playstore;arm64-v8a" -d pixel_6
$ANDROID_HOME/emulator/emulator -avd kawai_test -no-window -no-audio -no-snapshot-load

# `tauri android dev` NEVER returns — it stays attached to logcat after the
# app starts (Ctrl-C to stop). Two things bite on a fresh AVD: the debug APK is
# ~2.4 GB with debuginfo (use CARGO_PROFILE_DEV_DEBUG=0 → ~510 MB) and the
# default 6 GB data partition then fails with INSTALL_FAILED_INSUFFICIENT_STORAGE
# (disk.dataPartition.size=12G in the AVD config.ini + one `-wipe-data` boot).
# `bunx tauri` bypasses scripts/tauri.sh — no .env SDK/NDK, so use `bun tauri`.

# Manual equivalent of `bun tauri dev` (for extra flags like office dev):
cd src-tauri && env \
  RUSTFLAGS="-C link-arg=-Wl,-rpath,<ABS>/cognee-litert-lm/native" \
  LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
  LLVM_PROFILE_FILE=/dev/null \
  tauri dev -- --features litert

# Prepare the dev dylibs once (fills cognee-litert-lm/native/):
bun run bundle:litert

# CI release (.github/workflows/release.yml): on push to main a bot bumps the
# patch version in src-tauri/tauri.conf.json, commits + tags vX.Y.Z, then builds
# the macOS .app (tauri-action, features litert, bazel-cached) and the
# kawai-web binary into a draft GitHub release. A final `publish` job (needs:
# all build jobs) flips the draft to published + latest once every platform
# build is green (3 retry attempts for transient gh/API failures). Failures
# self-heal via workflow_dispatch: dispatching on a `chore(release): vX` HEAD
# re-enters release; the guard skips if vX is already published and otherwise
# RESUMES the draft (rebuild missing assets, republish). The bump COMMIT is
# pushed with GITHUB_TOKEN — a GITHUB_TOKEN push creates no push event, so
# ci/evals/windows-smoke/release never re-fire on a one-field version bump.
# The TAG is then pushed with RELEASE_TOKEN (PAT with contents:write) — a PAT
# event DOES trigger workflows, which is exactly what wakes release-android +
# bloat. The same PAT authenticates ALL github.com git traffic in the build
# jobs (insteadOf rewrite)
# — private submodules (cognee-litert-lm, nested LiteRT-LM fork)
# and private cargo git deps work without workflow changes. The frontend builds
# inside tauri-action via beforeBuildCommand ("bun run build"); setup-bun +
# bun install are already workflow steps.
# macOS bundles ad-hoc signed — `bundle.macOS.signingIdentity: "-"` in
# src-tauri/tauri.conf.json. No Developer ID certificate is in the release
# path, so Gatekeeper asks once per browser download; README.md "First launch"
# tells users to fetch with `gh release download`/`curl` (never quarantined),
# or `xattr -d com.apple.quarantine <the .dmg>` before mounting.
# Do NOT wire APPLE_* env vars into the macOS job to "fix" the dialog — GitHub
# exports unset secrets as EMPTY strings, so tauri would override the "-"
# identity with "" (tauri-cli reads APPLE_SIGNING_IDENTITY before the config
# value) and run notarytool with empty credentials — red release.
#
# Android release (.github/workflows/release-android.yml) — a SEPARATE
# workflow from release.yml on purpose: mobile and desktop have independent
# lifecycles, and an Android failure must never block or fail the desktop
# release. Trigger = a `v*` tag push (release.yml's bump job claims the tag
# with RELEASE_TOKEN — a PAT — and PAT-created events DO trigger workflows;
# GITHUB_TOKEN ones never do), so the Android build starts ~1 minute into the
# release run and runs IN PARALLEL with the desktop bundlers instead of
# waiting for the published release. Exactly one run per tag: bump is the only
# writer of `v*` tags. Desktop publish is NOT gated on it (publish.needs
# excludes it) — a slow/failed Android build never holds the release back,
# and the APK then lands on the already-published release. The QRIS job
# creates the draft itself when the desktop jobs haven't yet, and uploads with
# `gh release upload` (never action-gh-release, whose `draft: false` default
# would publish the draft early) so the APK is normally in place before
# publish flips it. Plus workflow_dispatch(tag) for a re-run.
# TWO VARIANTS per tag, built in PARALLEL by the reusable
# .github/workflows/release-android-build.yml (one call per variant):
#   • build-qris — `--features release-android` (the Cargo.toml alias,
#     identical to `release-desktop`: litert, tts, binance, accounting,
#     security on top of `desktop`; lonkero's headless-Chrome paths are
#     compile-time excluded on Android), universal APK only, attached to the
#     GitHub release. Top-up channel = QRIS (worker `/topup/qris/*`) +
#     voucher.
#   • build-play — `--features release-android-play` (= release-android +
#     `iap`), signed AAB uploaded to the Play internal track (packageName
#     pro.kawai.app) when PLAY_UPLOAD_ENABLED=true, plus its APK as a run
#     artifact for manual testing. Top-up channel = Google Play Billing
#     (tauri-plugin-iap; purchases verified + credited by the worker
#     `/topup/iap/*`); the QRIS + voucher UI is hidden by
#     `topup_iap_available` (Play's digital-goods policy) and the QRIS build
#     must never reach Play. The play build's --config merge REPLACES
#     app.security.capabilities with [default, iap] — tauri.conf.json lists
#     only "default", so builds that don't compile tauri-plugin-iap never
#     parse the plugin's capability file (src-tauri/capabilities/iap.json).
# Both variants share the applicationId + upload keystore (install-over moves
# a device between channels) and run the SAME verification battery (native
# strip/exports, dependency graph, R8 JNI classes) on their APK.
# Size: the release .so files are stripped by `stripReleaseNativeLibs` in
# src-tauri/gen/android/app/build.gradle.kts (`llvm-strip --strip-unneeded`,
# .symtab only — .dynsym/JNI/litert exports stay), which exports the
# unstripped copies to build/outputs/native-debug-symbols/ and uploads them as
# native-debug-symbols.zip both to Play and as a run artifact. The workflow
# verifies the packaged APK is stripped and keeps its JNI/LiteRT exports.
# arm64-only is enough for Play (64-bit required, 32-bit optional; Play splits
# the AAB per device), and a single-ABI APK avoids the multi-ABI sideload
# bloat — native libs are stored uncompressed in an APK. litert pins it to
# arm64: the LiteRT-LM C library is built for android_arm64 in-job and staged
# into jniLibs.
# Needs repo secrets ANDROID_KEYSTORE_BASE64 / _PASSWORD / ANDROID_KEY_PASSWORD
# / ANDROID_KEY_ALIAS / PLAY_SERVICE_ACCOUNT_JSON + repo variable
# PLAY_UPLOAD_ENABLED. keystore.properties is written from those secrets into
# src-tauri/gen/android/ (gitignored); without it the release build falls back
# to the debug key and the Play step is skipped with a warning annotation.
# versionCode = 10000 + the PARENT run_number (one code per release run; only
# the play variant's uploads consume Play codes — Play requires strictly
# increasing codes); versionName = the tag's semver. The signed AAB is kept as
# a 30-day run artifact (NOT attached to the public release, unlike the QRIS
# APK) so a manual Play upload or an exact re-submit is possible — rebuilding
# is not equivalent because Play rejects a re-used versionCode.
# Only the APP CREATION is manual: the Play Developer API cannot create apps,
# and a service account must be invited to the app with "Release" before any
# upload. The IAP products (tokens_10k/25k/50k/100k — kawai-server/worker/src/
# iap.ts catalog) are created by scripts/play-iap-products.py (idempotent
# oneTimeProducts.patch + activation, IDR anchors at QRIS parity, other regions
# converted by Play). It only works once a billing-enabled AAB is live: Play
# refuses product creation until an uploaded artifact declares
# com.android.vending.BILLING, which only release-android-play carries
# (tauri-plugin-iap's manifest), so the script runs AFTER the first Play-variant
# upload. Verification is
# server-side only (kawai-server/worker/src/iap.ts): the worker checks
# purchaseState + packageName + the MANDATORY sha256(email)
# `obfuscatedAccountId` bind (a purchase with no bind is refused, never
# credited), then credits idempotently per orderId. Refunds/chargebacks are
# reconciled server-side too: POST /internal/iap/refunds (+ /cursor) behind the
# SAME RECAP_SECRET bearer as /internal/recap* — purchases.voidedpurchases.list
# (one-time products, 24h window overlap, ms cursor with CAS, idempotent per
# orderId via iap_refunds) debits the ledger as `iap_refund:<orderId>`; the
# balance is ALLOWED to go negative (refund charges reality — recap's rule),
# and an account with >=2 refunds in 30 days hits a credit hold
# (purchase_hold_refunds, 403) instead of a debt. A run refuses (409
# refund_window_too_large) rather than silently truncating. The cron pass lives
# in crates/ops/recap beside the billing recap; this build + wiring deploy only
# after the first end-to-end purchase is proven on the internal track.

# Build the LiteRT-LM C library (first build ~15-30 min; cached afterwards)
cd cognee-litert-lm/vendor/LiteRT-LM && bazel build //c:litert-lm --config=macos_arm64 --jobs=6
# then copy + fix the dylib (see Landmines: rpath recipe)

# Distributable build (bundles LiteRT dylibs into the .app)
# First build the dylib (see Landmines), then:
bun run tauri:build:litert-office     # prepare dylibs + build (CI-release parity: --features release-desktop)
# Or step by step:
#   bash scripts/bundle-litert-dylibs.sh
#   bun tauri build -- --features release-desktop --config .github/tauri-litert.json

# Web standalone server (Axum serves /api/*; no frontend).
# Sign-in needs the auth worker reachable — KAWAI_WORKER_URL overrides its URL.
cargo run --bin kawai-web --features web

# Android (requires ANDROID_NDK_HOME + ANDROID_NDK_ROOT exported; uses cargo-ndk)
cargo ndk -t arm64-v8a -P 24 check      # NOTE: -P (capital), not -p
cargo ndk -t arm64-v8a -P 24 build

# iOS (requires full Xcode + xcode-select -s)
cargo check --target aarch64-apple-ios
cargo check --target aarch64-apple-ios-sim
```

## Verify before considering work done

**Do NOT run the `.github/workflows/ci.yml` jobs on this machine.** They are
sized for GitHub runners, not local hardware. Job by job:

| Job | What it runs | Why not locally |
|---|---|---|
| `web` | bun lint/test/build + `cargo check --no-default-features --features web` | Safe — same as the local checks below. |
| `linux-check` | feature-matrix `cargo check --all-features`, ~10 crates' unit tests, paddle_ocr_smoke, agent_eval harness, kawai-server typecheck | ~30-60 min cold; nothing here is unreachable locally, but run only the pieces relevant to your change. |
| `android-check` | `cargo ndk check` (aarch64, `--features release-android`) + NDK 28 install | Only when shared code, `litert`, `tts` or `binance` changes — and then just the one `cargo ndk -t arm64-v8a -P 24 check` line, not the job. |
| `android-smoke` (own workflow) | bazel-builds the android_arm64 litert `.so`, cross-compiles `local_llm_smoke` with release-android's feature set, then runs it under bionic via `adb` — `target=emulator` on a self-hosted Apple Silicon host (headless arm64 AVD, HVF) or `target=device` against a physical arm64 phone | NEVER run wholesale — the full aarch64 cross-compile + boot is heavy (and locally the bazel `.so` is already built: `native/aarch64-linux-android/`). Manual dispatch only: GitHub-hosted macOS runners are arm64 VMs without nested virtualization, so the AVD cannot boot there. Every-push Android coverage is the compile-only `android-check`. |
| `macos-smoke` | bazel-builds the LiteRT-LM C library (~15-30 min cold), `cargo test --features litert` (1-2h+ cold compile), downloads the Gemma 4 E4B (3.5 GB) fixture, then local_llm_smoke / draft_smoke / planner_smoke / analytics_smoke | NEVER run wholesale. CI runs them on every push. |
| `linux-build` + `linux-smokes` | linux-build: feature-matrix cargo checks + crate unit tests + the bazel-built litert `.so` (cached by LiteRT-LM commit). linux-smokes: local_llm_smoke (the Linux platform gate, against the cached dylib) + its half of the OS-independent smoke partition: remote_smoke / binance_smoke / monad_wallet_smoke — each smoke runs once per push, split with macos-smoke | NEVER run wholesale. CI runs them on every push. |

The exception is the targeted smoke for the code you changed: after touching
local inference run `local_llm_smoke`, after touching the remote tier run
`remote_smoke`/`draft_smoke` — with the dylibs already prepared
(`bun run bundle:litert`) and the model file already present. One smoke, not
the job.

Run all that apply. Everything must pass clean:

```sh
bun run build                  # frontend: tsc -b + vite build (frontend changes)
cargo check                    # desktop — axum must NOT compile here
cargo check --features web     # web module + kawai-web bin
cargo check --features litert  # local LLM (bindgen only; no C lib needed)
```

For mobile, also (during MVP: only when shared code changes — `logic.rs`, `auth.rs`, shared deps; UI/commands-only changes don't need these): `cargo ndk -t arm64-v8a -P 24 check` and/or `cargo check --target aarch64-apple-ios` (NDK r29 at `/opt/homebrew/share/android-ndk`; sim target needs `rustup target add aarch64-apple-ios-sim`).

## Documentation hygiene

Docs describe the **current state only**. History lives in git log, not in the rulebook.

- **Present tense, no migration story.** Never write "X was deleted", "X replaced Y", "superseded by", "formerly", "leftover from". Rewrite the section to describe what exists NOW.
- **Same-commit cleanup.** The change that deletes/replaces a component also removes its mentions everywhere: AGENTS.md (incl. the layout tree + Roadmap), `ARCHITECTURE.md`, `PLAN-*.md`, script/workflow comments, config samples. Before committing, `grep -rn "<thing>" AGENTS.md ARCHITECTURE.md PLAN-*.md scripts/ .github/` must come back clean.
- **Roadmap ✅ entries collapse.** Once an item ships, its entry states the current architecture in one block — drop sub-item history and delete superseded tiers (fold any surviving fact into the successor entry).
- **"legacy" is allowed only while the code still supports it** (e.g. the `KAWAI_DB_DIR` fallback) — otherwise it is stale content and goes.
- **Every credential is documented, never remembered.** Adding a secret (env var with a key/password/token, signing key, service-account key, CI secret) requires a row in [`../CREDENTIALS.md`](../CREDENTIALS.md) **in the same commit** — what it is, where the value lives, its fingerprint/ID, who consumes it, rotation path, blast radius if leaked. Values never go in that file (it is git-tracked); only locations and fingerprints. `kawai/.env` holds the local values, the GitHub repo secrets are the CI copy, and both are write-only from the CLI — a credential you cannot reproduce elsewhere is one you will eventually lose.
- **Code comments follow the same rule**: describe what the code does, never what it used to do.

## Troubleshooting

When debugging agent/tool-calling/hybrid-cloud misbehavior, follow
`TROUBLESHOT.md` (repo root): §1 evidence queries (messages, turn_log,
app.log traces), §2 the healthy-turn log shape, §3 symptom→root-cause→action
with exact commands, §4 the post-fix verification block.

For debugging on an Android device (logcat, the sandboxed `app.log`, WebView
DevTools, and auth/login-hang triage) see §2 "Android device" in
`TROUBLESHOT.md`.

## Landmines (things that already bit us)

- **`@types/hast` must stay pinned to 3.0.4.** `resolutions` in `package.json` forces it across the tree. 3.0.5 rewrites `Properties.className` to `string[]` and bun nests per-package copies (under `mdast-util-to-hast`, `@shikijs/*`, …), which SPLITS the `hast` module identity: `mdast-util-to-hast`'s module augmentation (`RootContentMap.raw`) stops applying to the copy `streamdown/lib/markdown.ts` sees → TS2367/TS2339 across the markdown renderer. If you bump it, `bun install --force` and re-check `find node_modules -path '*node_modules/@types/hast' -maxdepth 5 -type d | wc -l` is 1.
- **macOS: the ad-hoc bundle NEEDS `com.apple.security.cs.disable-library-validation`.** The .app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), so it carries no Team ID, and the bundled LiteRT-LM dylibs are prebuilt (not signed by us). With the hardened runtime on (Tauri default `bundle.macOS.hardenedRuntime: true`), dyld's library validation rejects any loaded non-platform library whose Team ID differs from the process's — an ad-hoc Team ID never matches — and the app dies at launch with `Library not loaded: @rpath/liblitert-lm.dylib … mapping process and mapped file (non-platform) have different Team IDs`. `src-tauri/Entitlements.plist` (wired via `bundle.macOS.entitlements`) carries that single entitlement. Re-codesigning the dylibs ad-hoc does NOT help, and re-signing the main binary does NOT either — only dropping the runtime flag (`hardenedRuntime: false`) or the entitlement unblocks the load.
- **Frontend deps must be installed before `tauri dev`/`tauri build`.** `bun install` in `kawai/` (Vite root is `frontend/`; deps live at the repo package root). CI already does this.
- **Vite `server.port: 1420` is `strictPort`** (Tauri `devUrl` expects exactly this port) and `watch.ignored` covers `src-tauri/**` — don't let vite watch the Rust side (rebuild loop).
- **`async_stream` streams are not `Unpin`.** `Box::pin(...)` before calling `.next()` in a loop.
- **`Channel::send` takes the value by value**, not `&event` (Tauri 2: `send(data: T)`).
- **`-p` in cargo-ndk collides with cargo `--package`.** Use `-P` / `--platform`. cargo-ndk's panic handler **dumps all env vars to stdout** — never let it panic, and keep secrets out of shell env.
- **`libsql-sys` / `aws-lc-sys` are C.** Mobile needs NDK clang (Android) or Xcode clang (iOS) plus libclang for bindgen. Verified working on android arm64 + ios arm64.
- **A mobile sandbox has no writable temp dir.** Never let a path resolve to `std::env::temp_dir()` on Android/iOS — the open fails, and for the LOG layer that failure is silent and total (no stderr tee, no `tracing`, no `frontend_log`), so on-device bugs become invisible. `kawai_paths::log_dir()` falls back to `<data_root>/logs` and the Tauri shell injects `<app_data>/logs` in `setup`; `logging.rs` re-resolves the path on every append because `init()` runs BEFORE that injection. Reuse `worker_client()` (10s connect / 30s total) for any new HTTP call — a bare `reqwest::Client::new()` on a phone network hangs for the OS TCP retry window, which reads to the user as an infinite spinner with no error.
- **`eprintln!` does NOT reach Grafana Cloud.** The Loki layer is a `tracing` layer gated at WARN/ERROR in a release build and INFO in a debug build (`KAWAI_LOKI_LEVEL` overrides), so a plain `eprintln!` reaches the local file + logcat and nothing else — and a wireless phone has neither a terminal nor logcat. Any failure you must diagnose off-device has to be a `tracing::*` event; `logging::write` (the `frontend_log` sink) mirrors into `tracing` for exactly that reason. Never make a Loki label a raw email/PII: the auth path emits a truncated `user_id_hash`, and Loki groups streams by the `user_id` field.
- **Cancellation is asymmetric by design.** Web: `AbortController` (connection drop auto-cancels the backend future). Desktop/mobile: frontend `cancel()` calls `invoke('cancel_stream', {streamId})` → `CancellationToken` in the shared registry breaks the `select!` loop. Streaming commands must accept a `stream_id` param and register/clean up a token.
- **Axum 0.8 `from_fn` hardcodes state to `()`.** A middleware that needs shared state can't use `from_fn` + `State<S>`; use `Extension` (our `auth_middleware` reads `Extension<Verifier>`) or `from_fn_with_state`. Don't fight the type inference by annotating `Router<S>` — switch to `Extension`.
- **`libsql` positional tuple params start at arity 2.** `(&str,)` is NOT `IntoParams`; use `vec![x]` (or an array) for a single param. Tuples `(A,B)` and up are fine. Params blanket-impl `T: TryInto<Value>` (so `&str`, `String`, `i64`, … all work).
- **Per-user DB connections are WAL; the PRAGMAs in `kawai_db::db_connection` are load-bearing.** Every op runs on its own connection against one file, so under load (onboarding memory persists + usage-ledger flushes + supervisor step results racing chat/session writes — seen on Android as `Couldn't start the analysis — database is locked` from `create_chat_session`) the default rollback-journal mode makes every commit wait on open readers and vice versa; busy_timeout alone could still lose the race. `db_connection` sets `busy_timeout = 10000`, `journal_mode = WAL` (readers/writer proceed concurrently; persists in the DB file, so existing installs convert on first connection after update), and `synchronous = NORMAL` (WAL: no per-commit fsync — a phone flash win; an OS crash may roll back the last commits, DB stays consistent). Pin: `connections_run_in_wal_mode` + `busy_timeout_actually_waits` in `crates/foundation/db`. Don't drop the pragmas.
- **Never hold a SQLite write transaction across an `.await`.** libsql executes local statements INLINE on the calling tokio worker (no background thread), so (a) every writer blocked on the lock freezes its own worker inside the busy handler, and (b) every `.await` inside `BEGIN`…`COMMIT` is a yield where the holder can park with the write lock open — other writers then burn workers waiting, the holder's continuation gets delayed, and the whole app cascades into `database is locked` until the burst drains (the onboarding-window lockout on Android). Multi-statement atomic writes go through ONE statement (`INSERT … VALUES (…), (…)`, the usage-ledger batch) or `execute_transactional_batch` (the migration runner) — single C-level execution, zero mid-lock yields.
- **Session JWTs are RS256; sqld accepts only EdDSA (post-MVP).** When sqld is added for multi-device sync, never pass a session JWT to sqld — mint an EdDSA token in the backend first.
- **`dotenvy` does not override existing env vars.** Shell-exported vars win over `.env` — an exported `KAWAI_WORKER_URL` beats the `.env` value.
- **The shared tool catalog is a self-hosted sqld on the dev machine** (`~/.kawai/sqld/toolcatalog/`, `127.0.0.1:8084`; devices reach it at `https://catalog.kawai.pro` through the `kawai-catalog` cloudflared tunnel; Turso retired — its free tier cannot absorb the per-device replica bootstrap, and the vector index's shadow table made the bootstrap 46 MB until the dead index was dropped; brute-force cosine over a few hundred rows is the actual search path). Auth is a single Ed25519 JWT key (`SQLD_AUTH_JWT_KEY_FILE`, raw base64url format — the PEM form silently fails with `JwtInvalid`): sqld has **no per-token permissions**, so any valid token is full read/write — the baked APP token leaks write access by construction; the DB is fully re-seedable from the repo, which is the accepted mitigation. Seeding: `KAWAI_TURSO_WRITE_TOKEN` = the SEED token (`.env`; locations + rotation in CREDENTIALS.md §2). Embeddings must come from the on-device LiteRT embedder — the same space plan-time queries embed in — or cosine silently returns noise instead of erroring.
- **One `KAWAI_TURSO_DB_URL` / `KAWAI_TURSO_AUTH_TOKEN` pair in `.env`, no duplicates.** The file carried two blocks at once and the second (`http://127.0.0.1:8084`) won when the file was sourced, so a seed reported success while writing to a local sqld instead of Turso. Declare the pair once, and verify with `echo $KAWAI_TURSO_DB_URL` before trusting any seeder output. `RemoteConfig::from_env` refuses a HALF override (only one env half set) instead of completing it from the baked pair, so a mixed URL + token can no longer address two different databases.
- **A catalog sync must never be dropped mid-flight, and freshness must never come from a replica mtime.** `Catalog::sync` runs the work in a spawned task (and `sync_detached` hands back the `JoinHandle`), so a caller's `timeout` expires only the WAIT: a sync future dropped inside WAL apply poisons the replica (`wal_insert_begin failed`, then permanently `database is locked`), and the per-replica `sync_lock` makes the retry queue behind the abandoned sync instead of racing it (`supervisor::sync_catalog_bounded` re-awaits the detached handle to log the late outcome). Freshness reads `<replica>.sync_stamp`, written by every completed sync (zero-frame included — that is the "we asked the remote, still current" answer mtimes cannot express), because merely OPENING a replica checkpoints its replication WAL into `catalog.db`: measured on a real replica, one read-only open moved the main file's mtime from 16 days stale to "just now", which makes an mtime-based gate skip exactly the sync that would have fixed it. The mtime set (`db`/`-wal`/`-info`/`-client_wal_index`, never `-shm`) survives only as the fallback for replicas predating the stamp.
- **Two `jsonwebtoken` versions coexist** (9.x is the `src-tauri` direct dep — reserved for future local token work; 10.x is transitive). Expected.
- **One `reqwest` (0.13) across the graph.** All first-party crates compile against 0.13 (feature name is `rustls`, not 0.12's `rustls-tls`; `.query()` needs the `query` feature; `bytes_stream()` needs the `stream` feature — the remote-tier SSE client uses it).
- **Bazel-built dylibs emit `default.profraw` into the CWD.** If that CWD is `src-tauri/`, the `tauri dev` watcher sees the file change after every run and rebuild-loops the app forever (window opens/closes infinitely). Always set `LLVM_PROFILE_FILE=/dev/null` when running instrumented dylibs from `tauri dev`.
- **The LiteRT-LM dylib's install name is a bazel-relative path.** `dyld` can't find it from `target/debug/kawai` unless you: (1) copy it out of bazel-bin, (2) `install_name_tool -id @rpath/liblitert-lm.dylib` + re-codesign, (3) embed an rpath in the consuming binary via `RUSTFLAGS="-C link-arg=-Wl,-rpath,<dir>"` (a dependency's `cargo:rustc-link-arg` does NOT propagate to the final binary; the app crate's own `build.rs` DOES — it now embeds `@executable_path/../Frameworks` for litert+macOS), and (4) `scripts/bundle-litert-dylibs.sh` copies all companions into `native/`, strips the baked-in `_solib` rpaths, and adds `@loader_path/../Frameworks` so the bundle (`.github/tauri-litert.json` → `Contents/Frameworks/`) and dev both resolve. `DYLD_LIBRARY_PATH` does NOT survive through the tauri CLI.
- **The engine hard-links `libGemmaModelConstraintProvider` and `libwebgpu_dawn`.** Both are `DT_NEEDED` dependencies of the main library on every desktop/mobile target (not dlopen'd plugins), so a release that stages only the main library aborts the process at load — macOS: `Library not loaded: @rpath/libwebgpu_dawn.dylib` (SIGABRT in `cargo test`), Android: `dlopen` failure on the app's first litert call. Upstream moves this set between vendor syncs (the prebuilt directory is the only source of truth), so the staging paths glob it instead of naming files: `scripts/bundle-litert-dylibs.sh` copies every `prebuilt/macos_arm64/*.dylib` and deletes EVERY `_solib_darwin_arm64` rpath generically, the Linux/Windows jobs copy `prebuilt/<platform>/*.{so,dll}`, and `scripts/stage-litert-android.sh` stages `libwebgpu_dawn.so` as required. Bundling configs still enumerate them by name (`.github/tauri-litert.json` macOS + linux, `src-tauri/tauri.windows.conf.json`) — a Tauri bundle fails outright on a listed file that no longer exists, so check those three when the prebuilt set changes.
- **LiteRT-LM streaming C calls are fire-and-forget async.** `litert_lm_conversation_send_message_stream` returns before generation starts; tokens arrive on an engine thread. Dropping the engine/conversation mid-generation segfaults. The blocking task must block until the final callback (`recv_timeout` on a channel fed from the callback) — see `logic::local_llm::local_chat`.
- **Engine load is a K/V-budget problem on phones — `load_model` halving-retries.** The K/V state is the largest allocation at engine build, so a memory-constrained device fails the WHOLE load with `UNKNOWN … Failed to allocate tensors` (observed repeatedly on Android, which took the local tier down permanently — every run then fell into the degraded raw-output path). `local-llm::load_model` therefore rebuilds `EngineSettings` at half the budget on an allocation failure (`is_allocation_failure`), down to `KV_RETRY_FLOOR` (2048); below that it returns an actionable "not enough memory" message instead of the bare C error. The budget actually in force lands in `EFFECTIVE_MAX_CONTEXT`, and the generation preflight reads `effective_max_context_tokens()` — NOT the configured value, or a downgraded engine is handed prompts it cannot hold and fails mid-generation. `KAWAI_LLM_MAX_TOKENS` stays the ceiling request, not a guaranteed capacity.
- **The degraded terminal answer is bounded.** When synthesis is unavailable (no remote tier, providers down, local writer unloadable) the supervisor's final answer is `degraded_raw_deliverable(raw)` — the last step's output marked as raw AND cut to `RAW_FALLBACK_PREVIEW_CHARS` (4000) with a pointer at the step card. Never widen it back to the verbatim dump: the last step is often a full provider JSON document, and pasting it whole is what made a failed Android run look like a broken product.
- **sentencepiece needs the patched recipe on macOS.** Upstream's v0.2.2 layout fails strict `hdrs_check`; our vendored WORKSPACE carries the fix (strip-to-src + `PATCH.sentencepiece_darts` + absl/protobuf seds + full absl deps in `BUILD.sentencepiece`). If you change the sentencepiece stanza, `bazel sync --only=sentencepiece` does NOT refetch — delete the repo dir under `/private/var/tmp/_bazel_*/external/sentencepiece` + its marker, then rebuild.
- **Tauri invoke rejects with a bare string, not an `Error`.** Read it via a helper (`errText` in `frontend/src/lib/api.ts`).
- **Web request structs need `#[serde(rename_all = "camelCase")]`.** Tauri maps camelCase invoke args → snake_case params automatically; Axum `Json<T>` does NOT — without the rename, camelCase bodies 422 (bit us 2026-08-16 with the chat ops). Every web request struct with a multi-word field carries the rename.
- **Tool call events in `LocalChatEvent`.** The `local_chat` stream emits `ToolCall` and `ToolResult` variants (not just `Token`). The frontend (`use-local-chat.ts`) AND `agent.rs` both match on the union — add arms for new variants in all matchers or events are silently dropped.
- **The remote tier has NO LLM SDK.** `crates/foundation/remote-llm` is a hand-written OpenAI-compatible SSE client (`POST {base}/chat/completions`, `stream_options.include_usage`, `reasoning_content`/`reasoning` delta spellings with `reasoning_details` as last resort, `[DONE]`, terminal usage chunk). Don't reach for a provider crate — extend the wire module; its unit tests pin the decoding.
- **Vendor error text never reaches the UI — `RemoteError::Display` is `"remote error"`.** Every provider failure (HTTP status, upstream body, transport text, failover trail) is a `remote_llm::RemoteError` whose `Display` is the single generic `REMOTE_ERROR_MESSAGE`; the provider label, status, upstream body and failover trail live only in `RemoteError::diagnostic()`, which goes to `tracing` (→ Grafana Cloud Loki), `app.log` and the Agent Observability export. Consumers propagate with `to_string()`/`format!`/`?` (`impl From<RemoteError> for String`), so a step card, run summary or chat bubble can only ever show the generic line — never hand-build an error string from provider output, and log `e.diagnostic()` while surfacing `e`. The on-device engine is the deliberate exception (`RemoteErrorKind::Local`): that message is ours, so it IS the user message.
- **pdf_oxide is a vendored submodule** (`../pdf_oxide`, behind the `office` feature). Every consumer declares the git dep and each workspace root patches the URL to the submodule (`[patch."https://github.com/yudaprama/pdf_oxide"]` in `src-tauri`, `crates`, and `kawai-web`), so src-tauri, ragloader, engines/office, and office-tools/pdf all build the same in-tree crate. MSRV 1.88, default features only (`icc` + `legacy-crypto`; no `rendering`/`ocr`/`fips` — keeps it C-dep-free). Cold compile of the office feature grows by a few minutes (pure Rust, cached afterwards). The markdown→PDF creator (`api::Pdf::from_markdown`) measures text through the page builder's embedded-font metrics — never the Base-14 fallback — and wraps words, renders GFM tables with rules (header tint + zebra stripes, grid boxed to the table width), takes a per-cell tint from a leading `{bg:#rrggbb}` directive (stripped before measurement, so it never widens a column or reaches the text layer — the `pdf_create_from_markdown` description teaches the agent the form), and paginates with repeated table headers. Inline parsing covers bold, italic, code, `[text](url)` links (accent-coloured, URL dropped), and `~~strikethrough~~`; block parsing covers `#`–`######` ATX headings (the closing `#` run is stripped, `#####`/`######` bottom out at the body scale; accent underline on H1, keep-with-next so a heading is never stranded at a page bottom), fenced code (indented fences included), accent-bar blockquotes, light-gray code panels (syntax-highlighted per fence language — keywords bold blue, strings green, numbers orange, comments gray), inline-code chips, bullet / ordered / GFM task lists (drawn checkbox), plus a page footer (title / date / page numbers via `PageTemplate`) set by `pdf_create_from_markdown`, which also takes `pageSize` (a3/a4/a5/letter/legal, default a4) and `orientation` (portrait/landscape) and renders through `PageSize::Custom`, so landscape A4 is a true 842×595 pt page rather than a scaled portrait one. The export TYPOGRAPHY is kawai's, not pdf_oxide's builder defaults: `crates/engines/office/src/pdf.rs::{BODY_FONT_SIZE (10.5 pt), BODY_LINE_HEIGHT (1.42), PAGE_MARGIN (58 pt ≈ 2 cm)}` build through `render_markdown_pdf`, the pure fn every stored PDF and deliverable export goes through (agent `pdf_create_from_markdown` + `export_deliverable`); tables render at 0.95× body and code at 0.9×, headings at 1.1×/1.25×/1.5×/2×. The footer rides `PageTemplate::new().footer(..).margins(PAGE_MARGIN, PAGE_MARGIN)` — `PageTemplate::default()` has ZERO left/right margins, which pins the footer to the paper edge instead of the text column. Tests `pdf_export_typography.rs`, `pdf_markdown_footer.rs` and `pdf_page_layout.rs` pin the sizes, the margins and the footer inset through that same fn. A metadata `title` renders a cover title block (large title, author · date, accent rule) unless the document opens with its own `# ` H1. Base-14 text metrics in `writer/font_manager.rs` are exact Adobe AFM values — do not "approximate" them again: layout wrap points and inline-run pen advances drift visibly at every style boundary when they are off. Two layout invariants the renderer enforces: a token with no space to break at (URL, hash, long identifier) is HARD-BROKEN at the margin (`wrap_runs` → `hard_chunks`) instead of running off the page, and a table column's minimum is capped at an even share of the grid so one long cell cannot widen the grid past the text area — and the header row is MEASURED in the bold face it is drawn in (a bold word is wider than the same word in the body face, which is what made header cells wrap at their own column edge). The markdown renderer has **no image blocks** (`LaidItem` = text / rule / rect only; `<img>` support lives exclusively in the `from_html_css` pipeline), so a deliverable's `![caption](kawai-file://<id>)` chart token becomes a standalone `[Image: <caption>]` line in the PDF export (`deliverable::inline_pdf_images`) — the bytes stay in the store, only the docx export embeds them. `pdf_info` reports the MediaBox SPAN (`urx - llx`, `ury - lly`), not its upper-right corner, so a page whose box starts away from the origin is not reported oversized.
- **PDF text replace is DOM-based, not content-stream regex.** `pdf_replace_text` composes `find_text` (regex predicate per element) + `set_text` — a match that spans fragmented sibling text elements in the content stream is NOT found, and replaced text keeps the original element bbox (no reflow). Fine for token substitutions (dates, names, codes); heavy rewrites should regenerate the source document (the `pdf_replace_text` tool description says exactly this).
- **Android TLS needs `rustls-platform-verifier` init before ANY Rust HTTPS call.** `reqwest`'s `rustls` feature verifies certs through `rustls-platform-verifier`, which panics (`Expect rustls-platform-verifier to be initialized`, `android.rs:90`) on first use unless initialized with the app's JNI context. On Android the Tauri shell does this in `lib.rs` setup via `ndk-context` + `jni` (android-gated deps in `src-tauri/Cargo.toml`). The Kotlin verifier component is the `org.rustls:rustls-platform-verifier` Maven artifact (declared in `gen/android` Gradle; the old vendored `CertificateVerifier.kt` is gone) — its version must stay in sync with `rustls-platform-verifier-android` in `src-tauri/Cargo.lock`, or the first TLS call crashes. Symptom when missing: every HTTPS call (auth, JWKS, remote LLM, Loki push) panics the tokio worker silently → infinite spinners, empty Grafana (the push thread dies too, so the device ships NOTHING to Loki). It never reaches Loki — panics are visible only in `adb logcat`.
- **The Android verifier needs crate ≥ 0.7.1, or every CRL-only cert fails as "Revoked".** On modern Android the platform verifier enforces revocation, and post-OCSP CAs (Let's Encrypt, some workers.dev chains) publish CRLs only — with 0.7.0 the result is `CertPathValidatorException: Certificate does not specify OCSP responder` → `invalid peer certificate: Revoked` → every HTTPS call fails with "auth server unreachable: error sending request" while Chrome on the same phone works fine (Chrome soft-fails revocation). 0.7.1 + component 0.2.0 permit CRL fetching (manifest-merged network security config). Symptom in logcat: `RustStdoutStderr ... failed to verify TLS certificate: invalid peer certificate: Revoked`.
- **R8 strips the verifier component from release APKs.** Release builds minify (`optimization { enable = true }` in `gen/android/app/build.gradle.kts`), and `CertificateVerifier` is instantiated from Rust via JNI by name — invisible to R8, which deletes it: debug builds log in, every release build fails its first HTTPS call with `auth server unreachable: error sending request`. The `-keep class org.rustls.platformverifier.**` rule in `gen/android/app/proguard-rules.pro` is load-bearing; release-android-build.yml carries a dex check that fails the build if the class is gone. Any new JNI-instantiated Java/Kotlin class needs the same treatment.
- **The tool catalog's TLS stack is NOT the platform verifier — it needs `kawai_tool_catalog::tls_connector`.** libsql builds its own connector (`HttpsConnectorBuilder::new().with_native_roots()` → `rustls-native-certs` → `openssl-probe`, which has no Android path) on rustls 0.22 / hyper-rustls 0.25 — a different major from reqwest's `rustls-platform-verifier` (0.23) — so the Android verifier init in `lib.rs` does not cover it and every catalog open died with `TLS error: no valid native root CA certificates found (0 invalid)` while the rest of the app's HTTPS worked. `tls_connector()` (`crates/foundation/tool-catalog/src/lib.rs`) supplies `webpki-roots` first and layers the OS store on top best-effort (desktop keeps private/corporate CAs); every remote open hands it to `Builder::connector` — `open_uncached`, `open_remote`, and the `fingerprints` remote read (a bare `new_remote` build there was missed once and TLS-failed every Android launch). It also sets a 10s TCP connect timeout: all three opens run on the planning path, and hyper's default (none) parks a phone with a dead radio for the OS retry window. Probe: `cargo run --example remote_tls_check` (baked constants) vs `--default-connector` (the pre-fix path — fails open on Android, works on desktop); see TROUBLESHOT §4.
- **AGP leaves prebuilt jniLibs unstripped, and an APK stores native libs uncompressed.** `strip<Variant>DebugSymbols` passes jniLibs through as-is, so `libkawai_lib.so` reaches the APK as 172 MB instead of 111 MB — every `.symtab` byte counts against the download. `stripReleaseNativeLibs` in `gen/android/app/build.gradle.kts` runs `llvm-strip --strip-unneeded` on jniLibs just before packaging (both AAB and APK variant merges), exports the unstripped copies to `build/outputs/native-debug-symbols/` for Play's native debug symbols, and replaces the Tauri symlink with a stripped regular file (intended). `release-android-build.yml` fails the build if the packaged lib still has `.symtab` or lost `Java_pro_kawai_app_Rust_ipc` / `litert_lm_*` exports. Never use `--strip-all` — it drops `.dynsym` too and breaks JNI plus `DT_NEEDED` resolution.
- **Never `-L` the NDK's version-less sysroot lib dir on Android.** `sysroot/usr/lib/<triple>/` holds ONLY static archives — including the NDK's `libc.a` — and no `libc.so`. Any `cargo:rustc-link-search` for it (ocr-rs's `emit_static_cpp_runtime_search_paths`, cognee-litert-lm's `LITERT_LM_LINK_TYPE=static` branch) makes rustc's trailing `-lc` resolve to `libc.a`, silently linking all of bionic into `libkawai_lib.so`; its private `__libc_shared_globals` is never initialized by the linker, so compiler-builtins' `init_have_lse_atomics` ELF constructor segfaults reading `auxv == NULL` at `System.loadLibrary` — instant force-close on every device, with no Rust panic and nothing in the app log. Stage the `.a` into `OUT_DIR` and put only that directory on the search path (both build scripts do this now); diagnose with `llvm-nm -D libkawai_lib.so | grep -w getauxval` → must be `U getauxval@LIBC`, never a local `t` definition.
- **`liblitert-lm.so` MUST be linked with `-Wl,-soname,liblitert-lm.so` on Android.** The Linux/Android branch of `c/BUILD` passes `c/litert_lm_c_api_linux.lds`, a version script, so the library exports the symbol node `LITERT_LM_C_API_1.0` and every consumer records a `DT_VERNEED` entry naming `liblitert-lm.so`. bionic resolves both `DT_NEEDED` and that verneed name against the loaded dependency's **`DT_SONAME`** (`VersionTracker::init_verneed` in `linker.cpp`), not its filename. A library built without `-soname` has an empty one, so `System.loadLibrary("kawai_lib")` dies before any Rust code runs with `dlopen failed: cannot find "liblitert-lm.so" from verneed[0] in DT_NEEDED list` — an instant crash with a perfectly valid APK (alignment, exports, dex all fine). `release-android-build.yml`, `android-smoke.yml` and `scripts/stage-litert-android.sh` all pass `--linkopt=-Wl,-soname,liblitert-lm.so`; diagnose with `llvm-readelf -V libkawai_lib.so` (verneed names must equal the `-d` SONAME of the staged libs).
- **`libc++_shared.so` only reaches the APK if the CDylib lists it in `DT_NEEDED`.** The MNN C++ objects pulled in by the OCR/TTS stack (`rust-paddle-ocr` → ocr-rs) reference libc++ runtime symbols (`_Znwm`, `_ZTISt12length_error`, `_ZTVSt*`, …) that nothing in the dependency tree defines — bionic ships no libc++ at all. They resolved accidentally against `liblitert-lm.so` while it exported the libc++ it links statically; the version script now hides everything but `litert_lm_*`, so `System.loadLibrary` dies with `dlopen failed: cannot locate symbol "_ZTISt12length_error" referenced by libkawai_lib.so`. Two pieces are required, and neither is enough alone: `src-tauri/build.rs` emits `cargo:rustc-link-lib=dylib=c++_shared` for android (puts the `DT_NEEDED` entry on `libkawai_lib.so`), and `stripReleaseNativeLibs` in `gen/android/app/build.gradle.kts` materializes cargo-mobile2's jniLibs **symlink** (into the NDK sysroot) into a real file before stripping, so `llvm-strip` can never rewrite the NDK's own copy. The staging itself is conditional on that `DT_NEEDED` entry — cargo-mobile2's `symlink_libs` copies `libc++_shared.so` only when `ndk.required_libs` (a readelf `-d` scan of the built `.so`) finds the name, which is why the build.rs line, not the Gradle task, is what fixes the missing library. `release-android-build.yml`'s "Verify native dependency graph" step resolves every undefined `_Z…` symbol against the packaged set, so a regression fails CI instead of the phone.

- **wry has NO hidden webview on Android — never create a scrape `WebviewWindow` there.** wry's Android `CreateWebView` hardcodes `activity.setContentView(webview)` (`wry/src/android/main_pipe.rs`), `visible(false)` is destructured away and never read, `set_visible` is `// Unsupported`, and `Window::add_child`/tauri `webview.hide` are desktop-only (`#[cfg(desktop)]`). A "hidden" webview therefore REPLACES the app's content view — this is what made raw StockTwits JSON cover the UI during a stock run — and wry has no Android teardown (`Drop` is desktop-only), so every fetch also leaked a live WebView (memory pressure that aggravates the `Failed to allocate tensors` model load). The Android tier-0 engine is `KawaiHeadless.kt` + `webview_engine.rs::android`: a detached `WebView` (never added to any view hierarchy — the standard Kotlin/Flutter headless trick) driven over JNI by static methods, results handed back by polling (`"V"+json` / `"E"+msg`), every view `destroy()`ed on finish. Any new JNI-instantiated Kotlin class needs a `-keep` rule in `gen/android/app/proguard-rules.pro` (same R8 landmine as the rustls verifier), and Kotlin-side scrape plumbing is invisible to `cargo` — syntax breaks only surface in the Gradle build.
- **On Android a backgrounded process is FROZEN ~10 s after it enters the cached state — an in-flight run must hold a foreground service, not merely react to lifecycle events.** The freeze suspends every thread (on-device generation stalls mid-token and resumes when the app comes back) and the system tears down the process's active TCP sockets (the remote tier's SSE dies under it); a killed process leaves no terminal event at all. Every streaming op therefore holds `android_foreground::RunGuard` (RAII, refcounted) across `run_streaming` — the single choke point every streaming op goes through — which starts `KawaiForegroundService` through the JNI-by-name `KawaiForeground` bridge and stops it when the last live run drops. The service type is `dataSync` (`shortService` caps at 3 minutes, shorter than a long generation) and it holds a partial wake lock, because with the screen off the CPU is suspended regardless of process state; `start`/`stop` failures (API 31+ background-start refusal) are `tracing::warn!`/`Log.w` only — they cost the run its protection, never the run itself. `KawaiForeground` is looked up by name from Rust, so its `-keep` rule in `gen/android/app/proguard-rules.pro` is load-bearing (same R8 failure mode as the rustls verifier; `release-android.yml` fails if the class is missing from the dex), while the service is manifest-declared and R8 keeps it on its own. Removing the task from recents is deliberately uncovered: the activity is destroyed, tauri's event loop exits, `main` returns and the process dies with the service. On a device the proof is visible — minimize mid-generation, the run notification stays up, the answer still arrives.

## Where things live

```
frontend/                        # React 19 + Vite + Tailwind v4 SPA (vite root)
├── index.html                   # entry, dark class on <html>
├── src/
│   ├── main.tsx                 # React root
│   ├── App.tsx                  # chat UI: session sidebar, Conversation, PromptInput, tool cards
│   ├── lib/
│   │   ├── ai-types.ts          # LOCAL UIMessage/part type shim (NO ai-sdk runtime)
│   │   ├── api.ts               # call() RPC + errText + backend payload types
│   │   ├── stream.ts            # streamOperation(): Channel + cancel_stream
│   │   ├── clipboard.ts         # copy/paste helpers (browser APIs)
│   │   ├── download.ts          # triggerDownload helper
│   │   ├── file-types.ts        # extension → FileKind classification
│   │   ├── utils.ts             # cn() + misc
│   │   ├── themes.ts            # color palettes: token store, tweakcn/shadcn registry import, <html> application
│   │   └── streamdown/          # vendored markdown/streaming renderer (from web/)
│   ├── hooks/
│   │   ├── use-local-chat.ts    # chat state: LocalChatEvent → UIMessage parts, sessions, model mgmt
│   │   ├── use-streamdown.ts    # streamdown plugins/config (i18n stripped → English)
│   │   ├── use-copy-button.ts   # copy button state
│   │   └── use-copy-to-clipboard.ts
│   ├── components/
│   │   ├── ai-elements/         # vendored chat components (from web/; trimmed)
│   │   │   └── tool-renderers/  # per-domain tool result cards
│   │   ├── ui/                  # shadcn primitives (from web/)
│   │   └── file-icon.tsx        # CDN file-type icons
│   ├── platform/                # slim local adapter (types, index, shared-media) — browser APIs only
│   └── assets/                  # icon-map.json + utils (file icon naming)
src-tauri/src/logic.rs           # PURE logic; libsql + local_llm (litert) + db token minting
src-tauri/src/logic/rag.rs       # office-gated RAG: chunk/embed/index (status tracked in rag_files) + session-scoped knowledge_search + knowledge_list/add_to_session/import_youtube/delete_file + image description (ragloader)
src-tauri/src/logic/office/      # office domain (feature "office"): mod.rs + store.rs + ooxml.rs + pdf.rs + tools.rs
src-tauri/src/webview_engine.rs  # tauri-side WebViewFetch: hidden WebviewWindow + eval_with_callback extractor (office feature; registered in lib.rs, never in kawai-web)
crates/foundation/remote-llm/  # hybrid-tier cloud client (RemoteLlm): hand-written OpenAI-compatible SSE client, provider pool (gateway-zai → gateway-deepseek → gateway-venice → openrouter) with health-aware failover; kawai-tools ToolSet registries live in kawai-tools/ (agent loop + web read tiering live in crates/engines/agent + crates/toolsets/webread)
src-tauri/examples/              # headless dev tools: local_llm_smoke (on-device streaming), remote_smoke (cloud tier), draft_smoke (draft_document e2e), tts_smoke (supertonic TTS e2e), turn_log_report (hybrid calibration), trading_plan_smoke (Trading Performance plan → real merged registry → scheduler, seeded temp ledger), agent_eval (H1 orchestration-quality gate — 20 office scenarios, E4B baseline 20/20)
src-tauri/src/logging.rs         # stderr tee → platform log dir (macOS ~/Library/Logs/, Linux $XDG_STATE_HOME)
src-tauri/src/auth.rs            # compat shim → kawai-auth crate (Session type + load_dotenv)
src-tauri/src/logic/local_auth.rs # remote email+password auth → kawai auth worker (D1 directory, Ed25519 bearer)
src-tauri/src/commands.rs        # #[tauri::command] wrappers + Channel + cancel registry
src-tauri/src/android_foreground.rs # Android run guard: refcounted foreground-service hold around every streaming run (no-op off Android)
src-tauri/gen/android/            # generated Android project: MainActivity.kt, KawaiHeadless.kt (detached-WebView scrape), KawaiForeground.kt + KawaiForegroundService.kt (run-guard foreground service), proguard-rules.pro (JNI-by-name -keep rules)
src-tauri/src/web.rs             # Axum routes (feature-gated "web") + auth_middleware
src-tauri/src/bin/web.rs         # standalone web server entry
src-tauri/src/lib.rs             # Tauri builder; .manage(...); generate_handler!
src-tauri/examples/local_llm_smoke.rs  # headless local-LLM smoke test (features litert)
src-tauri/Cargo.toml             # axum/tower-http behind "web"; cognee-litert-lm behind "litert"
src-tauri/build.rs               # tauri_build + embeds @executable_path/../Frameworks rpath (litert+macOS)
src-tauri/Entitlements.plist      # macOS: com.apple.security.cs.disable-library-validation (see Landmines — the ad-hoc litert bundle needs it)
cognee-litert-lm/                # Rust bindings for the LiteRT-LM C API (path dep)
cognee-litert-lm/vendor/LiteRT-LM         # submodule = upstream google-ai-edge main + macOS patches
cognee-litert-lm/native/         # gitignored: prepared LiteRT-LM dylibs (bundle-litert-dylibs.sh fills this)
office_oxide/                    # submodule (path dep, office feature): pure-Rust docx/xlsx/pptx CREATE + read + EDIT + info (markdown → IR; raw-part surgery for in-place edits)
kawai-tools/                     # the agent tool seam: AgentTool trait + ToolSet registry (name-keyed, type-erased dispatch)
crates/foundation/venue/         # venue-neutral exchange types: Venue, VenueFill/Position/Asset, VenueError, VenueClient
crates/toolsets/binance/         # Binance agent tools (feature `binance`): market data, futures mirror, execution, venue fill history
crates/toolsets/mexc/            # MEXC agent tools (feature `mexc`): fills sync into the same venue-keyed history; own keys only
crates/toolsets/security-tools/  # Security agent tools (feature `security`, builtin.security): recon / targeted scan / module catalog / subdomain enum over the vendored lonkero engine — in-process (`lonkero::standalone::run_scan` on a dedicated thread; the engine future is !Send), flat kind-tagged envelopes, `security_scan` auto-approved (`requires_confirmation = false`). Smokes: `cargo run -p security-tools --example security_smoke` (tool loop vs a local vulnerable server) and, from `src-tauri/`, `cargo run --example security_plan_smoke --features litert,security` (plan → merged registry → confirmation policy → scheduler, real scans vs the same kind of local target; an optional `-- <target>` arg audits that site instead — the nightly windows-smoke audits https://kawai.pro)
crates/lonkero/                  # vendored web-security scanner (own .git, excluded from the crates workspace): 127 modules behind `lonkero_scanner`; lib seams = `standalone::run_scan` (the one end-to-end pipeline, no Redis), `groups` (category→module IDs, shared with `ai::tools`), `scope::ScopeConfig`, `ai::system_prompt::methodology_prompt` (persona source for builtin.security). Its vendored #[cfg(test)] modules are pre-broken (stale vs current APIs) — `cargo test` is not a usable gate here; compile with `cargo check --lib --bins`
crates/                          # split-out first-party crates (foundation / engines / toolsets / integrations / generated-tools / vendor); crates/vendor/accounting-core is a vendored copy of accounting-blue (double-entry ledger + Indian GST) whose invoice PDF renders through pdf_oxide; exposed as the `builtin.accounting` agent via the `accounting` feature and crates/toolsets/accounting
nautilus_trader/                # submodule, REFERENCE-ONLY: never a workspace member or path dep. nautilus-binance does NOT replace binance-sdk in-app — see PLAN-nautilus-integration.md §5.1
models/                          # .litertlm model files (gitignored, GB-scale)
design-demos/                    # UI mock HTML files (standalone)
.env                             # local env (gitignored; dotenvy at startup; KAWAI_WORKER_URL overrides the auth worker)
.env.local                       # optional build-time overrides read by Vite (e.g. VITE_SENTRY_DSN; gitignored)
scripts/sqld/run-local.sh        # the tool-catalog sqld host (`toolcatalog` instance on 127.0.0.1:8084; public exposure via tunnel; squawk = per-user local SQLite, no sqld)
scripts/bundle-litert-dylibs.sh  # prep all LiteRT dylibs into native/ for bundling into the .app
.github/tauri-litert.json        # merges LiteRT dylibs into `bundle.macOS.files` (Contents/Frameworks)
app.log                          # symlink → platform log dir (macOS ~/Library/Logs/kawai/; on-device: <app_data>/logs/app.log)
```

## Adding a new operation (checklist)

1. Write the pure fn (+ any event enum) in `logic.rs`. Events: `#[serde(tag = "type")]`.
2. Add the `#[tauri::command]` in `commands.rs`:
   - RPC: return `Result<T, String>`.
   - Streaming: take `stream_id: String` + `on_event: Channel<E>` + `State<StreamRegistry>`; loop with `tokio::select!` racing `token.cancelled()` vs `stream.next()`; register/remove token by `stream_id`.
   - If it requires auth: take `State<Session>`, read claims, pass `claims.sub` to the `logic.rs` fn as `user_id`. The frontend never passes `user_id`.
3. Add the Axum route in `web.rs`: RPC → `Json<T>`; streaming → `Sse<impl Stream<Item = Result<Event, _>>>`. Register it in `router()`.
   - If it requires auth: mount it on the `protected` router (behind `auth_middleware`) and take `Extension<auth::Claims>`; pass `claims.sub` to the same `logic.rs` fn. Public ops stay on `public`.
4. Register the command in `lib.rs` `generate_handler!`.
5. Call from React: `call('<name>', args)` from `@/lib/api`, or `streamOperation('<name>', args, handlers)` from `@/lib/stream` — mirror any new event variant in the matching union type (e.g. `LocalChatEvent` in `hooks/use-local-chat.ts`).
6. Verify: `bun run build`, `cargo check`, `cargo check --features web`.

## Adding a tool or workflow (checklist)

The accounting build took a week to land and three silent failures to
*find*, all the same shape: every layer verified green, the app still
degraded to raw JSON. The rules below exist because each one was learned
the expensive way. They are not stylistic preferences — skipping them is
what produced the mess.

**Process (non-negotiable, and cheap):**

1. **Read two siblings before writing wiring.** Stock Research, Crypto
   Screener and Futures Risk Audit already do what you are about to do.
   Copy their shape; do not invent a parallel one. A new submission path
   next to an existing one is the single most expensive thing you can add
   — it is what made the trading workflow's plan never claim its template.
2. **Run the real path once before calling it done.** Headless green is
   not evidence the feature lives; unit tests assert your assumptions,
   not the system. One end-to-end pass (chip → review gate → step →
   card, or `plan_task` for a template) is the minimum.
3. **"It should work but shows raw JSON" is a WIRING gap, not a logic
   bug.** Check in this order, it's ~10 seconds each: the tool name in
   `route_log` / `supervisor_step_results`, the view registry that path
   uses, then the payload shape the tool actually emits.
4. **Fixtures come from the producer.** Capture the tool's real output
   (a throwaway example that calls the tool is fine) and paste it into
   the test. Hand-written fixtures drift silently and every renderer
   test passed while the app rendered JSON.

**A new tool is done when:**

1. **Output is FLAT with a `kind` discriminator** — the repo-wide
   convention (`audit_data`, `desk_data`, `screener`). No envelope
   wrapper: views guard on `kind` and refuse foreign payloads.
   Wrapping in `{ report: … }` is what broke every accounting report
   card. Pagination is a root sibling key.
2. It is registered in the view registry the **step** path uses
   (`tool-views/index.tsx` → `renderStepReport`) AND in the chat
   inspector (`tool-renderers/index.tsx`) — or a comment says why it
   deliberately has no view. `registry-coverage.test.ts` enforces this.
3. `cargo test -p <crate>` has a test that CALLS the tool and pins the
   JSON paths the frontend reads (the accounting equivalent is
   `report_payloads_are_flat_and_kind_tagged`).
4. It has a chat catalog entry when it is dispatchable as an agent tool
   (`toolseed <domain>`; embeddings come from the local model).

**A new pipeline / workflow is done when:**

1. **The plan builder lives in the domain crate**, not in `templates.rs`
   — `kawai_desk::build_desk_plan` is the pattern: the fixed command AND
   the router template call the SAME builder, so chip and free text can
   never disagree. The builder contract: it NEVER panics — fallible
   validation happens inside and returns `Result<TaskPlan, String>` (a
   plain op error the planner/router can recover from).
2. Its steps dispatch tools that exist in the registry the template
   DECLARED (`PlanTemplate.registry_kind` in `templates.rs` — `Template`
   for pipelines whose stage tools live outside the merged catalog, `Auto`
   for merged-catalog tools; `supervisor::registry_kind_for_plan` only
   reads it). Run `registry.validate_plan(&plan)` in a test — an
   undispatchable plan is as broken as no plan.
3. A `plan_task` end-to-end test claims the goal through the REAL merged
   registry and asserts `usage.input_tokens == 0` (the planner was
   skipped). This is the only test that caught the trading-workflow
   failures.
4. Side-effecting steps get an explicit confirmation decision —
   `requires_confirmation` on the tool, forced by the executor's
   `enforce_confirmation_policy`. Never rely on a step flag being
   absent, and never let a policy default fail open on side effects.
   The scheduler never retries a gated step (one approval = one call),
   and `plan_key` hashes the plan with the derived flag cleared so the
   pre- and post-enforcement hashes are identical.
5. `plan_key` is the SHA-256 of the plan JSON and keys the persisted
   `supervisor_step_results` memo, so a plan that serializes identically
   on every run REPLAYS a previous run's step outputs. Use the shared
   helpers — `kawai_router::stamp_run_nonce` (last step) or
   `kawai_router::new_run_nonce` (pipelines that carry it on every step,
   like the futures audits). The nonce is a STRING: a number once
   silently ran an audit phase on DEFAULT args via `parse_args`' `{}`
   fallback (TROUBLESHOT.md). A builder that skips it shows stale data
   on the second press.
6. **A step whose tool has its own budget must declare `timeout_ms`.**
   `SchedulerLimits::default()` is a 60s step timeout, and the supervisor
   runs with it — a step that dispatches an in-process engine with a longer
   internal budget (the security tools: 240s) is killed mid-run and reports
   `step timed out after 60000ms`. The builder sets
   `TaskStep::timeout_ms` to the tool's budget plus a dispatch margin
   (`security_tools::plan::STEP_TIMEOUT_MS`), and a builder test pins it.
7. **`kawai_router::check_plan_conventions(&plan, language)` passes in
   the builder's tests.** It enforces the invariants above (structural
   validity, tool-dispatched steps, one distinct string run nonce, the
   goal language rule iff the locale rides the goal — desk/youtube ride
   it per-STEP instead). The template completeness test in `templates.rs`
   runs it for every registered template; non-template builders (futures
   audits, screener, youtube, desk) call it in their own tests. Build
   steps with `TaskStep::tool_step`, and route the report language
   through `goal_in_language`/`goal_in_language_verbatim` — do not
   re-hand-roll any of them.

**One source of truth per fact.** The slot resolution, the confirmation
policy and the plan builder each existed in two places during the
accounting build, and the copies diverged. If you catch yourself writing
a second implementation of something that already resolves a slot,
validates a plan or builds a plan — extract it and share it instead.

## Authentication

- **Remote email+password accounts.** The user directory lives in the auth worker's D1 (`kawai-worker`, Cloudflare). The password never leaves the device: the client derives `credential = SHA-256(hex(salt) || kawai_vault::encode_string(password))` — deterministic, so the same email signs in from any device. The 16-byte salt is generated client-side at sign-up, stored server-side, and fetched via `POST /auth/salt` at sign-in. Implementation: `logic/local_auth.rs` (worker URL: `KAWAI_WORKER_URL`, default the production deployment; the same worker serves topup + dyntoken).
- **Sign-up verifies email ownership — on the device.** `auth_send_code` generates a 6-digit code in-process (`logic/email.rs`) and mails it through the Brevo SMTP relay (`crates/integrations/email`, SMTP password from `kawai_constants::brevo::get_brevo()`), keeping it in a per-process map for 10 minutes (single use); `auth_verify_code` checks the user's input locally, then `auth_sign_up` registers the account at `POST /auth/sign_up` with `{email, salt, credential}` — no code field, and the code never reaches the worker. The map is in-memory, so restarting the app invalidates pending codes. Sign-in is password-only (`auth_sign_in`). Probe: `cargo run --example email_smoke` from `src-tauri/` sends a real code and verifies the one you type back.
- **Password reset verifies email ownership — at the worker.** Unlike sign-up, the reset code can NOT be client-side: reset updates an EXISTING account, so anyone who knows the victim's email could call the confirm endpoint directly and a code verified on-device proves nothing to the worker (sign-up gets away with it only because the worker's 409-on-duplicates is the real gate). `auth_reset_request` asks the worker (`POST /auth/reset_request`) to generate a 6-digit code, store only its SHA-256 in KV (`pwreset:<email>`, TTL 10 min, 5-attempt cap, 3 requests/hour quota counted for every address — the generic `{ok:true}` response never reveals whether the email exists), and email it via the Brevo REST API (worker secret `BREVO_API_KEY`, same master key as the client relay). `auth_reset_confirm` posts the typed code plus a fresh client-derived `{salt, credential}` to `POST /auth/reset_confirm`; on success the worker updates the D1 row and bumps the per-user session epoch (KV `epoch:<email>`) — every bearer minted before the bump is rejected at verification (`mintToken` stamps the epoch, `verifySignedToken` refuses older ones), so a reset kills ALL sessions, not just one `jti`. The client then drops its stored token (`clear_stored_token`) and the user signs in with the new password.
- **Session = worker-minted Ed25519 bearer (7 days).** Each token carries a unique `jti`; `logout` revokes it at the worker (`POST /auth/logout` — a KV denylist entry keyed by the `jti`, TTL = the token's remaining validity) BEFORE the client drops its local copy, so a copied bearer dies with the sign-out instead of living out its 7 days. Tokens without a `jti` (pre-revocation mints) are rejected at verification, and tokens carrying a session epoch older than the live one (a password reset happened) are rejected too. Web: `kawai_session` HttpOnly cookie (`SameSite=Lax`, 30 days; `Secure` intentionally omitted for plain-HTTP localhost dev) — `auth_middleware` resolves the cookie to the user email through the worker (5-minute in-memory cache, evicted for the token on logout) and injects `Extension<user_id>`. Desktop: the token persists at `<user_data_dir>/auth.token` with a `<data_root>/last_session` pointer; `lib.rs` setup calls `restore_session()` at startup, so a restart doesn't re-prompt.
- **Identity → logic**: wrappers extract the user id (web: `Extension<user_id>`; desktop: `State<Session>`) and pass it as the first arg into `logic` fns. The frontend never sends a user id.
- Auth operations (one snake_case string each): `auth_send_code`, `auth_verify_code`, `auth_sign_up`, `auth_sign_in`, `auth_reset_request`, `auth_reset_confirm`, `whoami`, `logout`.
- Router split (`web.rs router()`): `public` holds `greet`, `list_agents`, `generate_activity`, `logout`, the Monad chain-read ops (`check_monad_balance`, `monad_chain_status`, `get_token_balance`, `get_token_info`, `estimate_gas`), and the auth ops above; everything else — including `whoami`, the device-wallet ops (`monad_wallet_address`/`_create`/`_sign_message`/`_delete`) and every fund-moving op — sits on the `protected` router behind `auth_middleware`. On desktop the same split is per-command (`State<Session>`).
- The auth UI lives in `frontend/src/features/auth/` (`auth-gate.tsx` sign-in/sign-up form, `use-auth.ts` whoami/logout bootstrap).

## Database (local SQLite via libsql)

Desktop MVP: single-device, local SQLite file, no sync.

```
user → auth session (worker bearer) → Rust backend → user_id
                                                    │
   per-user data directory ◀───────────────────────┘
   <data_root>/<user_id>/          ← one folder per user (backup unit)
   ├── kawai.db                    ← Builder::new_local(path)
   └── docs/                       ← office store (files + .meta.json)
```

- `logic::db_connection(user_id)` opens a per-op local SQLite connection; the office store defaults into the same per-user dir (`logic::db::user_data_dir`). Every `db_connection` runs `logic::db_migrations::ensure_schema` first (idempotent, transactional, guarded in-memory per data dir) so schema is always current — do NOT re-add scattered `CREATE TABLE IF NOT EXISTS` in callers.
- Data root resolution: `KAWAI_DATA_DIR` env → legacy `KAWAI_DB_DIR` env → injected root (`logic::db::set_data_root`; Tauri injects the app-data dir — on macOS `~/Library/Application Support/pro.kawai.app`, from the `pro.kawai.app` identifier in `src-tauri/tauri.conf.json`) → `/tmp/kawai`. `KAWAI_DOCS_DIR` still overrides the docs root to the legacy `<root>/<user_id>/` layout; unset = unified per-user dir. `[A-Za-z0-9_-]` user ids pass through as dir names, anything else hex-encodes.
- **One data directory per user — no `user_id` columns.** Isolation is structural (per-user folder), matching the future sqld-namespace model (Roadmap 16). The `office` RAG tables (`rag_chunks` + FTS5 mirror, `rag_files` index-status, `session_files`) follow the same rule; `session_files(session_id, file_id)` scopes knowledge search to everything a session has referenced.
- Post-MVP: sqld for multi-device sync, EdDSA token minting, embedded replicas.

## Configuration (.env)

Project-root `.env` (gitignored) — backend reads these via `auth::load_dotenv()` at startup:
```
KAWAI_WORKER_URL=...           # optional: auth/topup/dyntoken worker override (default: https://api.kawai.pro)
# Data root: NOT env-configurable. Injected by the Tauri shell (app-data dir,
# ~/Library/Application Support/pro.kawai.app on macOS); headless binaries fall
# back to <temp>/kawai.
# On-device model: NOT env-configurable. kawai_paths::model_candidates searches
# ./models → <repo>/models → models/ + resources/models/ next to the exe →
# <app_data>/models (the shell-injected user models dir).
KAWAI_LLM_MAX_TOKENS=16384       # optional context budget (K/V state entries) for the on-device conversation; default 16384, clamped below the model's max (Gemma 4: 32003). Larger = more K/V memory; raise for longer sessions before the prefill-overflow reset. A device that cannot allocate this budget halves it and retries at load (floor 2048, see Landmines); the preflight then uses the budget actually in force.
# ── Hybrid LLM tier — cloud subagents (crates/foundation/remote-llm) ──
# Provider pool with health-aware failover: every provider with a vault key
# joins the pool in fixed priority (gateway-zai → gateway-deepseek →
# gateway-venice → openrouter); a retryable failure (429/5xx/401/404/transport) moves that
# provider to cooldown and the next candidate serves the call. No vault keys
# and no gateway session ⇒ pool empty ⇒ agents behave pure-local. No kill-switch env — an empty
# vault is the off state.
KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS=16384  # per-subagent-call output cap
# ── Web read tiering — Cloudflare fallback budgets (logic/scrape.rs) ──
# Per-user and global daily caps on Cloudflare Browser Rendering calls (the
# on-device webview tier is free and unbudgeted). Exhaustion returns a
# guidance-carrying tool result, not an error.
KAWAI_CF_PER_USER_DAILY=25    # default 25
KAWAI_CF_GLOBAL_DAILY=300     # default 300 (dev-wallet fuse)
# ── Remote operational logs — Grafana Loki (crates/foundation/telemetry) ──
# Level gate for the Loki push layer, read from the runtime env first and from
# the COMPILE-TIME value second (a phone cannot export env into the app, so a
# release APK under test bakes it: KAWAI_LOKI_LEVEL=info bun run tauri:...).
# Unset: release builds ship WARN/ERROR, debug builds ship INFO.
KAWAI_LOKI_LEVEL=warn         # off|error|warn|info|debug|trace
```
`.env.local` (gitignored) — reserved for future auth configuration (unused by the React frontend).

## Roadmap

Priority order: **MVP track → post-MVP/pre-release → end state**. Items in the later tracks are deferred — do not start them without the user asking. Where things live in the codebase today: `local_llm_reset` / `local_llm_set_thinking` / `local_llm_unload` are already wired (commands + web routes).

### MVP track (now — desktop, on-device LLM, remote email auth)

1. **Chat history persistence.** ✅ Done 2026-08-16: `sessions(agent_id, title, …)` + `messages(session_id, role, content, …)` tables in SQLite (per-user DB — no user columns); ops `create_chat_session`/`list_chat_sessions`/`list_chat_messages`/`append_chat_message` (both wrappers). The default agent is `builtin.office` (the single catalog entry served by `list_agents`); sessions are created lazily on first message, first user message seeds the title, engine context stays in-memory (restart shows history, model context starts fresh).
2. **Distributable desktop build.** ✅ Done 2026-08-17: `scripts/bundle-litert-dylibs.sh` preps the LiteRT dylib set (the main C API plus every `*.dylib` in `vendor/LiteRT-LM/prebuilt/macos_arm64/`) into `cognee-litert-lm/native/`; `.github/tauri-litert.json` copies them into `Contents/Frameworks/` via `bundle.macOS.files`; `src-tauri/build.rs` embeds the `@executable_path/../Frameworks` rpath (litert+macOS) so the release .app needs no dev rpath/env. Local: `bun run tauri:build:litert(-office)`.    CI builds via `tauri-action --config .github/tauri-litert.json`.
3. **`local_llm_smoke` streaming regression gate.** ✅ Done 2026-08-20: `.github/workflows/ci.yml` runs `macos-smoke`, `linux-smoke`, and `windows-smoke` jobs (each bazel-builds the LiteRT-LM C engine natively, then runs `cargo test --features litert --lib` → `local_llm_smoke` (Gemma 4 E4B fixture, downloaded per run) / `remote_smoke` / `draft_smoke`), plus a `web` job (ubuntu: `bun install` + `bun run build` + `cargo check --no-default-features --features web`) and a `linux-check` job (`cargo check` default + all-features combo, crate unit tests, paddle-ocr + agent_eval-harness tests) and an `android-check` job (`cargo ndk check` for aarch64 with `--features release-android` — the compile gate proving both the supertonic/ocr-rs MNN chain and the cognee-litert-lm bindgen build over the nested LiteRT-LM C headers compile for android arm64). The Android runtime gate is a separate, manually dispatched `android-smoke.yml` on a self-hosted runner (`target=emulator` on Apple Silicon with HVF, or `target=device` against a physical arm64 phone over `adb` — a host without a hypervisor fails the preflight in seconds): it bazel-builds the android_arm64 `.so` with release-android's recipe, cross-compiles `local_llm_smoke` with the same feature set and runs it under bionic — load, streaming, and turn-2 history on the stack Android actually ships. GitHub-hosted macOS runners are arm64 VMs without nested virtualization, so the AVD cannot boot there; every-push Android coverage is the compile-only `android-check`. The `agent_eval` quality suites (office 19/20, analytics 16/18, screener 8/10) live in `.github/workflows/evals.yml` (three macos-26 jobs, own dylib builds) and run in parallel with ci and the release build; windows-smoke repeats the office suite on the nightly schedule only. `agent_smoke` stays skipped (interactive cloud state).
4. **(standing) Upstream maintenance.** sentencepiece macOS fix — PR [#3262](https://github.com/google-ai-edge/LiteRT-LM/pull/3262), assume ignored. Submodule stays on our fork branch (`yudaprama/LiteRT-LM@fix/macos-sentencepiece-hdrs-check`); `cognee-litert-lm/tools/update-litert-lm.sh` rebases the fix onto new upstream main. If merged, drop the commit and repoint at `google-ai-edge` main.

### Post-MVP, pre-release (first milestones after MVP ships)

5. **Agent tier foundation — the product's core.** Agent = persona (system prompt) + curated toolset from `kawai_tools::ToolSet` registries (`toolset_for(names)`, used standalone). Runs on **local Gemma 4** (decision 2026-08-16): prompt-based tool calling — tool definitions embedded in the system prompt, model replies with JSON tool calls, backend loop in `logic.rs` parses → dispatches via ToolSet → feeds results back. Ship a built-in agent catalog (specialist personas per category), the three-pane UI (left: agent list; right: sessions of the selected agent; center: agent content) — rebuild on the React frontend, and session persistence keyed by `agent_id` (schema from MVP 1). Remote models stay optional configuration (the hybrid cloud-subagent tier), wired only if/when local quality proves insufficient.
   - ✅ Tool call events in `LocalChatEvent` (2026-08-18): `ToolCall` + `ToolResult` variants; the React frontend renders tool cards in conversation (`App.tsx` + `components/ai-elements/tool`).
   - ✅ React frontend (2026-08-18): React 19 + Vite + Tailwind v4 (`frontend/`), components vendored from the `web/` SPA — chat, sessions sidebar, thinking toggle, tool cards.
   - ✅ Knowledge injection Tier 2 (2026-08-19): idle-time RAG in `logic/knowledge/` — `office_index_file` (extract → chunk 1500/overlap 200 → `kawai-embedding` on-device LiteRT EmbeddingGemma → libsql vector store `rag_chunks`), hybrid retrieval (vector + FTS5/BM25 mirror fused via RRF), `knowledge_forget` (disassociate + orphan chunk purge).
    - ✅ Knowledge injection Tier 3 (2026-08-19): `knowledge_search` as an AGENT TOOL, query-only. Upload happens exclusively in the files panel (session-scoped: `office_index_file` indexes + associates the file with the active session). The office agent calls `knowledge_search(query, mode?)` itself; `user_id`+`session_id` are bound server-side when the toolset is built (the model can never supply them). Retrieval mode (optional, defaults to `hybrid`): `hybrid` = vector+BM25 fused via RRF; `semantic` = vector only (paraphrased/conceptual questions); `keyword` = BM25 only, skips the embedder (exact codes/numbers/names — fastest). Unknown values are rejected server-side. Composer is text + image (+ file @-mention chips since 2026-08-22 — the @ button attaches file IDS to the next submit; the backend binds them to the session and lists them in the prompt. Referencing only: file CONTENT never enters the composer or the submit payload — the agent still reads it through tools). No submit-time content injection. The `knowledge_context` op (office feature) remains as a plain extraction helper (per-file 12k / total 36k char caps).
   - ✅ Agent catalog UI three-pane + per-agent session routing (2026-08-19): pane 1 = agent list (collapsible rail; catalog served by the `list_agents` op — backend `logic/agent.rs` is the single source of truth for ids, frontend `AGENT_META` in `App.tsx` only adds presentation), pane 2 = active agent chat + canvas, pane 3 = sessions of the selected agent (period-grouped, ⌘1/⌘2/⌘3 pane shortcuts). Sessions carry `agent_id`; switching agents resets model context.
   - ✅ Session delete (2026-08-19): op `delete_chat_session` (both wrappers) — deletes `session_files` rows, messages, and the session; indexed chunks stay (files own them). UI: per-session trash button (hover) in the sessions sidebar; deleting the active session starts a fresh chat (`deleteSession` in `use-local-chat.ts`).
   - ✅ Session file tracking UI (2026-08-19): `list_session_files` op (both wrappers) + Files tab split into "In this session" (green checkmark) and "All documents" sections. `useKnowledgeFiles` hook tracks session changes and fetches session-scoped file list. Importing files refreshes both lists.
   - ✅ Knowledge base panel revamp (2026-08-19): Files tab → **Knowledge** tab (sections "In this session" / "Library"). Index status is now visible: `rag_files(file_id, status, chunks, error)` tracks `indexing → ready/failed` in `office_index_file` (stale `indexing` rows read as failed). One list op `knowledge_list` (both wrappers) returns metadata + index state + `inSession` (replaces the panel's two-call fetch; `office_list_files`/`list_session_files` remain). Scope is explicit: `knowledge_add_to_session` associates + auto-indexes chunkless files, `knowledge_forget` (existing) removes from session, `office_delete_file` deletes everywhere (store + chunks + vectors + associations). Rows show badges (Indexing… / N chunks / Index failed + retry) and hover actions; import indexing is tracked instead of fire-and-forget.
    - ✅ Single-source knowledge ingestion (2026-08-19): the knowledge panel is the ONLY intake — composer attachments/screenshot/drag-drop stripped (pasted images are routed into the knowledge import pipeline, not the model). Images import through the office store (ext allowlist + `png/jpg/jpeg/gif/webp`) and index via `ragloader`'s `DescriberChain` (local stub → JigsawStack VOCR; local-only images surface as `failed` until LiteRT-LM multimodal lands). YouTube links ingest via `knowledge_import_youtube` (both wrappers): `youtube_transcript` fetch (en→id→first available fallback) → `yt-<id> <title>.md` in the store → associate + index, deduped by name prefix. Fixed `ragloader` to compile in-tree (`#[async_trait]` on `ImageDescriber`, `text_splitter::Characters`, `jigsawstack::visual::VisionRequest` path) + made `jigsawstack::Querier` Send+Sync.
    - ✅ Hybrid cloud-subagent tier (2026-08-20): long-form synthesis delegates to cloud subagent *tools* `deep_write` (long text) and `draft_document` (files); the on-device `local_chat` op keeps local Gemma 4 as the on-device path. `toolset_for` adds `deep_write` only when a remote LLM is configured (`remote.is_some()`); `draft_document` is gated behind the `office` feature. `RemoteLlm::from_env` builds a **provider pool** from the kawai-vault **compiled-in** keys (zero-config cloud): fixed priority (signed-in) gateway-zai (glm-5.3-flash) → gateway-deepseek → gateway-venice → openrouter, with health-aware failover (cline + poolside REMOVED 2026-11-11: cline streamed empty responses, poolside deactivated its model version — baked `get_cline`/`get_poolside` keys no longer read; zai-DIRECT + ollama REMOVED same day: the baked zai key answers 401 upstream and the ollama account has no credits — `OLLAMA_MODEL` now `beam:cloud`, returning via the gateway once `OLLAMA_API_KEY` is set and a gateway-ollama candidate is added), cooldown from `Retry-After`, capped 300s; cooled candidates stay last so a turn never hard-fails — and a pool whose candidates are ALL cooling after transient faults waits out the earliest cooldown once (≤40s) and makes one final pass before exhausting, so thin pools (CI smokes, signed-out openrouter fallback) survive single-provider rate limits. A signed-in session additionally unlocks the **gateway tier** (`kawai-server/worker` `/v1/*` model-routed passthrough, deployed 2026-11-11): `gateway-zai` (`zai/glm-5.3-flash`), `gateway-deepseek` (`deepseek/deepseek-chat`) and `gateway-venice` (`venice/deepseek-v4.1-flash` — venice is gateway-ONLY since 2026-11-11: no direct candidate, the baked `get_venice` key is no longer read by the pool) LEAD the pool — zai-direct and ollama-direct were removed the same day (the baked zai key answers 401; ollama's account has no credits and its old model was retired), authed by the session bearer published via `remote_llm::set_gateway_bearer` (set in `local_auth::persist_token`/`restore_session`, cleared in `commands::clear_local_session`; never set on web — multi-user process, same rule as telemetry's `CURRENT_USER`). Billing is unchanged — the client still meters to `usage_ledger` → `/billing/usage-replay`; the gateway's upstream provider keys stay server-side. The failover boundary is the first text token handed to the consumer — a provider that streams zero text (empty completion) fails over too. Headless `chat_route_check` + `remote_smoke`/`draft_smoke` examples exercise the loop; `turn_log_report` calibrates. No vault keys and no gateway session ⇒ agents behave pure-local.
   - ✅ Web read tiering (2026-08-23): `web_read(url)` agent tool (office) backed by an engine chain — **tier 0** on-device browser render (`webview_engine.rs`, injected into pure `logic/scrape.rs` via the `WebViewFetch` trait, registered in `lib.rs`, never in kawai-web; desktop: hidden `WebviewWindow` + `eval_with_callback` extractor, Android: detached WebView driven over JNI by `KawaiHeadless.kt` — wry has no hidden webview there, every wry-created webview calls `setContentView` and takes over the app UI) → **tier 1** Cloudflare Browser Rendering `/markdown` (the generated `browser` crate tool; vault key pool built in). Tier-0 misses are decided by anti-bot marker detection (`looks_like_challenge`) + min-content check; cloud spend is bounded per-user (`KAWAI_CF_PER_USER_DAILY`, default 25/day) and globally (`KAWAI_CF_GLOBAL_DAILY`, default 300/day), budget exhaustion returns a guidance-carrying result (not an error); 15-min cross-engine LRU cache (64/user) keyed by normalized URL; content capped at 12k chars. `kawai-web` degrades to Cloudflare-only; no engine ⇒ tool unregistered. External pages have NO Tauri IPC — the only data-return channel from a scraped page is the extractor JS result (`eval_with_callback` on desktop, `evaluateJavascript` on Android).
   - ✅ PDF engine: pdf_oxide, in-process (2026-08-21): pdf_oxide is the **vendored submodule** (`../pdf_oxide`, behind the `office` feature, default features only); ALL PDF ops run in-process via `spawn_blocking`. `logic/office/pdf.rs` exposes six pub fns: `pdf_extract_text` (emits `--- page N ---` prefixes via per-page `to_markdown`), `pdf_search_text` (`{page, matches}` groups via `TextSearcher`), `pdf_replace_text` (regex, capture-group aware, via DOM composition `find_text` + `set_text`), `pdf_merge`, `pdf_split`, `pdf_info` (`DocumentEditor`). `capabilities().pdfcli` is constant `true` (field name kept for API compat); the PDF agent tools register unconditionally under office — all office + PDF ops are in-process, no subprocess engine remains. Downstream: `crates/integrations/ragloader` extracts per-page via `PdfDocument::extract_text`, and the office PDF tools run in-process; both resolve pdf_oxide through the workspace. Notes: extraction output comes from pdf_oxide's markdown converter (good with columns); already-indexed chunks stay valid, re-ingest to reindex with the new extractor. DOM-replace limitation: regex matches spanning fragmented sibling text elements are not found (see Landmines).
6. **Production auth.** ✅ Done (remote worker accounts): email+password accounts in the auth worker's D1, sign-up gated by a 6-digit email code, worker-minted Ed25519 bearers — web carries `kawai_session` (HttpOnly cookie), desktop persists `<user_data_dir>/auth.token` and auto-restores on launch. See Authentication.
7. **Desktop/mobile session persistence — keychain hardening.** Core persistence is done (bearer at `<user_data_dir>/auth.token` + `restore_session()` at launch). Remaining: move the token into the OS keychain (`tauri-plugin-stronghold` / keyring) instead of a 0600 file.
8. **Desktop/mobile DB token broker.** For sqld sync: `logic::mint_db_token` reads the Ed25519 private key locally — fine for dev, but the private key MUST NOT ship in a production app. Add a `db_token` op: kawai-web verifies the identity → mints a short EdDSA token → the device fetches it and feeds `Builder::new_remote_replica`. The private key stays server-side. **(Post-MVP — requires sqld setup)**
9. **Production hardening.** Add `Secure` to the session cookie (HTTPS only), CORS only if cross-origin, rate limiting, token refresh rotation.
10. **Connection pooling + token refresh.** DB connections are opened per-op (correct, not optimal). Pool them for production load.
11. **SQLite schema migrations.** ✅ Done 2026-08-21: hand-rolled `schema_migrations` table + versioned, transactional migration runner in `src-tauri/src/logic/db_migrations.rs` applied on every `db_connection` (with an in-memory `OnceLock<HashSet<PathBuf>>` guard keyed by per-user data dir so per-op connections skip the check). Migrations are `include_str!`-loaded `.sql` files in `src-tauri/migrations/`: `0001_baseline` (sessions/messages+index/turn_log), `0002_backfill_untitled_sessions` (the legacy empty-title backfill), `0003_office_tables` (session_files + rag_files, `#[cfg(feature="office")]`), `0004_session_archive` (archived + archived_at columns on sessions), and `0005_remap_chat_agent` (builtin.chat → builtin.office). NOT refinery/rusqlite_migration (they assume rusqlite, we use the libsql API). The FTS5 mirror (`rag_chunks_fts` + triggers) stays created at runtime in `rag.rs::ensure_fts` because `CREATE TRIGGER` requires `rag_chunks` to already exist (the knowledge crate's vector store creates it on first index); `rag_chunks`/embeddings tables are knowledge-crate-owned and intentionally excluded. Add new schema via a new `<NNN>_name.sql` + a `Migration` entry in `migrations()`; cover it with a test in `db_migrations.rs`'s `tests` module (runs in the CI `cargo test --features litert,office --lib` gate).
12. **Tests beyond the smoke gate.** Unit tests for `logic/local_auth.rs` (credential derivation), `logic.rs` (db round-trip), agent tier (toolset assembly, agent catalog integrity).

### End state (desktop + mobile + web — design work, later)

13. **Mobile LLM builds.** Built: `release-android.yml` (parent + reusable `release-android-build.yml`) bazel-builds the LiteRT-LM C library for android_arm64, stages it into jniLibs (`scripts/stage-litert-android.sh`), and ships TWO variants per tag: the QRIS APK (`--features release-android`, attached to the GitHub release) and the Play AAB (`--features release-android-play` = release-android + `iap`, uploaded to the Play internal track when PLAY_UPLOAD_ENABLED; Google Play Billing top-up, QRIS+voucher hidden by `topup_iap_available`) — both with the release-desktop tiers (litert, tts, binance, accounting, security on top of `desktop`; lonkero's headless-Chrome paths are compile-time excluded on Android) — aarch64 only, since the .so exists for arm64 and a GB-scale model does not fit a 32-bit address space. The model file is NOT bundled: `local_load_model` resolves candidates under `<app_data>/models` and falls back to `logic::ensure_model` (HuggingFace download) when absent. The omitted `gpu` flag defaults per platform (`commands::default_gpu`): GPU on desktop (Metal covers the Gemma opset), **CPU on Android** — phone OpenCL runtimes do not cover every op of the plain Gemma `.litertlm`, and an unpatched LiteRT-LM GPU branch builds a GPU-only accelerator set that dies at load with "Some ops are not accelerated". The vendored GPU branch carries a kawai fork patch (`llm_executor_settings_utils.cc`: `kGpu | kCpu`, the NPU branch's partitioning pattern) so explicit GPU opt-ins fall uncovered ops back to CPU; whether a given phone's OpenCL stack runs the mixed graph is device-dependent, tracked by the non-blocking `--gpu` probe in `android-smoke.yml`. Mobile UI work rides on this (the React frontend's platform adapter covers file intake + save; see `frontend/AGENTS.md`).
14. **Windows/Linux desktop builds.** ✅ Shipped — `release.yml` builds all three desktop platforms, each bundling the litert dylibs (`tauri-litert.json` `bundle.macOS.files` / `bundle.linux.deb.files` / `bundle.linux.appimage.files`). No cross-compile from macOS — build each platform on its native GitHub Actions runner (`macos-14+` arm64 / `windows-latest` MSVC / `ubuntu-22.04` for glibc ≥ 2.35) with bazel caching (`actions/cache`, GB-scale) + `tauri-action` for bundling. Upstream bazel carries `linux` (clang) and partial Windows (MSVC) flags — never exercised by us; our sentencepiece patch is macOS-specific (may need sibling patches per OS). flutter_gemma proves the C lib works on Windows x86_64 (DX12/Dawn GPU) and Linux x86_64+arm64 (Vulkan/Dawn; glibc ≥ 2.34) via prebuilt binaries — consider prebuilts vs building from source per platform. Bundling differs per OS: macOS `@rpath`+codesign (current recipe), Windows DLL-exe-adjacent + vcredist (+ `dxil`/`dxcompiler` for GPU), Linux `.so` + `$ORIGIN` rpath. Windows is the highest-risk target (MSVC flags unexercised). **CI jobs added** (`build-linux`, `build-windows` in `.github/workflows/release.yml`) — both ship `--features litert` bundled via `tauri-action`. Linux uses `--config=linux_x86_64` (clang), Windows uses `--config=windows` (MSVC). Sentencepiece patch may need Linux/Windows siblings if `hdrs_check` fails on those platforms. Known: Windows `bazel-bin/c/litert-lm.dll` output name (not `liblitert-lm.dll`); the MSVC import library is emitted as `litert-lm.if.lib` (bazel's interface-library naming — copy it to `native/litert-lm.lib`, the name rustc `-llitert-lm` searches for), no `install_name_tool` equivalent, no `codesign`. The engine's companion libraries — `libGemmaModelConstraintProvider` and `libwebgpu_dawn`, both hard `DT_NEEDED` dependencies of the main library — are NOT outputs of `//c:litert-lm`: they ship in `vendor/LiteRT-LM/prebuilt/<platform>/`. Every CI job stages that directory beside the main library (`scripts/bundle-litert-dylibs.sh` for macOS, `scripts/stage-litert-android.sh` for jniLibs, a `prebuilt/*.so|*.dll` copy for Linux/Windows) and `tauri-litert.json` / `tauri.windows.conf.json` bundle them.
15. **Web platform support.** Investigate running kawai from a browser. Three approaches: (A) the React frontend built for web + `@litert-lm/core` WASM for client-side inference, (B) Rust backend as inference proxy (server-side), (C) hybrid. flutter_gemma already proves `@litert-lm/core` works in-browser with WebGPU. Open questions: WebGPU availability, model download UX (GB-scale), browser memory limits, whether to duplicate effort or share with flutter_gemma. Needs design doc before implementation.
16. **`--enable-namespaces` on sqld** for hard per-user DB isolation (token `sub` → namespace) instead of shared-namespace + `WHERE user_id`.
17. **Gemma 4 GPU (Metal) — blocked upstream.** The `-gpu.litertlm` variants need backend `GPU_ARTISAN`, which maps to engine types (`kAdvancedLegacyTfLite`/`kLegacyTfLite`) that upstream deleted; only `kAdvancedLiteRTCompiledModel` registers now → `No available engine for GPU_ARTISAN`. The plain `.litertlm` is CPU-locked by its section backend-constraint (`engine_settings.cc:78` rejects mismatches). Revisit when upstream ships a GPU path for the compiled-model engine.
18. **LoRA support.** LoRA adapters enable on-device personalization (custom writing style, domain expertise, local language/slang). C API supports `set_lora_path` on SessionConfig and `set_lora_rank` on EngineSettings, but kawai uses the Conversation API which manages sessions internally — cannot inject SessionConfig. Options: (A) switch from Conversation API to Session API (big refactor, lose chat history/prompt templating), (B) wait for upstream to add LoRA to ConversationConfig, (C) hybrid approach. Fine-tuning on-device not yet supported by LiteRT-LM. Open questions: which use cases justify the refactor? How big is the Session API migration?

### Backlog (parked)

19. **Accounting agent — built, wedge chosen: trading books, design
    finalized.** Double-entry ledger + reconciliation + Binance fills import,
    shipped as 24 tools on `builtin.accounting`. The flagship workflow is a
    NEW **Trading Performance** template (per-pair PnL, fee summary, win
    rate, integrity gate — period-driven); the Futures Risk Audit gains an
    automatic books-sync wave — no consent gate, idempotent and
    exchange-derived (unrealized stays venue-only — realized events only, by
    design). Parks outside all shipping surfaces — not in
    `bun tauri dev`, CI, or release bundles — until the 7-step activation
    plan in [PLAN-accounting.md](PLAN-accounting.md) is done (fill-meta side
    table + per-pair reads, audit wave, template, agent_eval, dev flag,
    live smoke, CI/release decision).

20. **Security agent (`builtin.security`) — shipped 2026-10-27.** The vendored
    lonkero web-security scanner (127 modules, `crates/lonkero/`, own repo
    excluded from the crates workspace) exposed as four credential-free agent
    tools on the `security` feature (`crates/toolsets/security-tools/`):
    `security_recon` (passive GETs), `security_scan` (active payloads;
    auto-approved — `requires_confirmation` is false, category → module groups shared with lonkero's
    own AI agent via `lonkero::groups`), `security_modules` (catalog), and
    `security_subdomains` (DNS enum). All scans run in-process on a dedicated
    thread (engine future is `!Send`) under a 240s tool budget and return
    flat, `kind`-tagged envelopes the chat + workbench registries render as
    severity-sorted finding cards (`registry-coverage.test.ts` gates them).
    Persona = kawai loop rules + authorized-targets directive + SMAC-5
    hostile-output rule composed with `lonkero::ai::system_prompt::
    methodology_prompt` (one methodology source for both hosts).
    `cargo run -p security-tools --example security_smoke` proves the loop
    end-to-end against a local vulnerable server. Ships in the desktop release
    feature set (`release.yml` macOS/Linux/Windows: `security` rides
    `release-desktop`; Android ships it too via `release-android` — lonkero's
    headless-Chrome paths are compile-time excluded there) and in `bun tauri
    dev`. Workflow: the **Security Audit** fixed pipeline
    (`security_tools::plan::build_security_audit_plan` — recon → one
    auto-approved active scan per category, sequential; chip form +
    `security_audit` router template + `run_security_audit` op +
    `/api/run_security_audit`; the `plan_task`-proving probe is
    `cargo run --example security_plan_smoke --features litert,security`
    from `src-tauri/`, whose optional `-- <target>` arg audits that site —
    the nightly windows-smoke audits https://kawai.pro). Deferred: session-pinned
    scope registry (`lonkero::scope` extraction exists), scan-progress
    streaming, persisted reports, Android.
