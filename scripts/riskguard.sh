#!/usr/bin/env bash
set -euo pipefail

# riskguard.sh — Binance futures risk-guard cron (crates/ops/riskguard)
# dengan path yang benar. Argumen diteruskan utuh ke biner kawai-riskguard.
#
# Usage:
#   bash scripts/riskguard.sh --once              # satu siklus lalu keluar
#   bash scripts/riskguard.sh                     # loop tiap 15 menit
#   bash scripts/riskguard.sh --limit 30          # grade 30 posisi teratas
#   bash scripts/riskguard.sh --interval-secs 300 # loop tiap 5 menit
#
# Perlu: pernah sign-in di app (pointer `<data_root>/last_session`) + kredensial
# Binance (Settings → Binance API, atau baked pair). Peringatan keluar sebagai
# baris `PERHATIAN:` — arahkan stdout/stderr ke file log jika dipakai cron.

cd "$(dirname "$0")/.."
exec cargo run --quiet --manifest-path crates/Cargo.toml -p kawai-riskguard -- "$@"
