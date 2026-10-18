# kawai

A supervisor-driven AI workspace: state a goal, the remote-LLM planner decomposes it into a
plan against a registry of agent tools, and a deterministic scheduler executes it — with every
step's report and a final deliverable in one view. Runs fully on-device where possible
(LiteRT-LM), with health-aware cloud failover.

Free desktop distribution — no app store. Auto-update is built in (signed with minisign;
every release publishes a `latest.json` manifest that installed apps check at launch).

## Download

| Platform | File |
|---|---|
| macOS (Apple Silicon) | [kawai_aarch64.dmg](https://github.com/yudaprama/kawai/releases/latest/download/kawai_aarch64.dmg) |
| Windows x64 | [kawai_x64-setup.exe](https://github.com/yudaprama/kawai/releases/latest/download/kawai_x64-setup.exe) |
| Linux (AppImage) | [kawai_amd64.AppImage](https://github.com/yudaprama/kawai/releases/latest/download/kawai_amd64.AppImage) |
| Linux (deb) | [kawai_amd64.deb](https://github.com/yudaprama/kawai/releases/latest/download/kawai_amd64.deb) |
| Linux (rpm) | [kawai_x86_64.rpm](https://github.com/yudaprama/kawai/releases/latest/download/kawai_x86_64.rpm) |

All links resolve to the newest published release. Browse everything (including historical
versions and the standalone `kawai-web` server binary) on the
[Releases page](https://github.com/yudaprama/kawai/releases).

> **Note:** the stable download names above resolve from release **v0.3.3+** onward
> (`assetNamePattern` in the release workflow). Earlier releases used versioned asset
> names.

## First launch

- **macOS** — the release `.app` is **ad-hoc signed** (no Developer ID certificate in the
  release path), so macOS treats it like any other unsigned download: a `.dmg` fetched in
  a browser gets tagged `com.apple.quarantine`, and the first launch shows the
  *"Apple could not verify …"* dialog. Three ways out, cheapest first:

  ```sh
  # 1. fetch it with a client, not a browser — no quarantine flag at all:
  gh release download kawai_aarch64.dmg -R yudaprama/kawai   # or: curl -fLO <the URL in the table>
  # 2. already downloaded? clear the flag on the .dmg BEFORE opening it, then drag as usual:
  xattr -d com.apple.quarantine ~/Downloads/kawai_aarch64.dmg
  # 3. or dismiss it once — right-click the app → Open
  ```

  With (1) or (2) nothing inherits the flag and every launch is clean; in-app updates never
  re-trigger it. An older copy that macOS calls *damaged* (before v0.3.4, which shipped
  without a bundle signature seal) is fixed by `xattr -cr /Applications/kawai.app`.
- **Windows** — unsigned installer: SmartScreen shows "Windows protected your PC" →
  **More info → Run anyway**. Updates installed through the in-app updater do not re-trigger it.
- **Linux** — AppImage (`chmod +x`, run) or install the deb/rpm.

## Building from source

Rust workspace (`src-tauri/`, `crates/`) + React 19 frontend (`frontend/`). See
[AGENTS.md](AGENTS.md) for the architecture map and the build commands (`bun tauri dev` for the
desktop app with the on-device LLM stack).

The standalone web server (Axum, no Tauri) builds via
`cargo run --manifest-path kawai-web/Cargo.toml --release`.
