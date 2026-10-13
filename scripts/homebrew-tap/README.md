# Homebrew tap skeleton — kawai (macOS, Apple Silicon)

One-time bootstrap: publish these two files as the ROOT of a new public repo
named `homebrew-tap` under the `yudaprama` account.

```sh
gh repo create yudaprama/homebrew-tap --public --clone
cd homebrew-tap
cp -R <kawai-repo>/scripts/homebrew-tap/Casks .
git add Casks && git commit -m "kawai cask" && git push
```

Users then run:

```sh
brew tap yudaprama/tap https://github.com/yudaprama/homebrew-tap
brew install --cask kawai
```

## Why :latest + auto_updates

The app ships a minisign-verified in-app updater (GitHub Releases
`latest.json`), so the cask pins nothing: `version :latest` +
`auto_updates true` means brew installs once and never nags. The download
permalink is stable across releases because `releaseAssetNamePattern` in
`.github/workflows/release.yml` strips the version from asset names.

## Constraints

- `depends_on arch: :arm64` — only Apple Silicon dmg is built today; drop the
  guard when an x86_64 build joins the release assets (and switch the url to
  an `on_system_blocks`-style arch dispatch).
- First launch still hits the Gatekeeper prompt (ad-hoc signature) — the cask
  cannot remove that; users right-click → Open once.
