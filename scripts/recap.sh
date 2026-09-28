#!/usr/bin/env bash
set -euo pipefail

# recap.sh — Billing recap cron lokal (crates/ops/recap) dengan path yang benar.
# Argumen diteruskan utuh ke biner kawai-recap.
#
# Usage:
#   bash scripts/recap.sh --once              # DRY-RUN sekali (tanpa mutasi)
#   bash scripts/recap.sh --once --apply      # tagih sekali + geser cursor
#   bash scripts/recap.sh --apply             # loop tiap 5 menit (mode apply)
#   bash scripts/recap.sh --once --rebase --apply   # geser cursor ke sekarang, tanpa menagih
#
# Tanpa `--once` biner LOOP terus (tiap 5 menit) — selalu sertakan `--once`
# untuk operasi sekali-jalan. Secret dibaca dari `.env` root
# (GRAFANA_SERVICE_ACCOUNT_TOKEN, RECAP_SECRET).

cd "$(dirname "$0")/.."
exec cargo run --quiet --manifest-path crates/Cargo.toml -p kawai-recap -- "$@"
