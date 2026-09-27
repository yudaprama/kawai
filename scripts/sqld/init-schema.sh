#!/usr/bin/env bash
# Apply scripts/sqld/schema.sql to a sqld instance over HTTP (Hrana /v2/pipeline).
# Works identically against a local sqld and a remote VPS sqld.
#
# Usage:
#   ./init-schema.sh [SQLD_URL]
#   SQLD_URL=http://127.0.0.1:8082 ./init-schema.sh
#   SQLD_URL=https://squawk.example.com SQLD_AUTH="Bearer <jwt>" ./init-schema.sh
set -euo pipefail

URL="${1:-${SQLD_URL:-http://127.0.0.1:8082}}"
AUTH="${SQLD_AUTH:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SQLD_URL="$URL" SQLD_AUTH="$AUTH" python3 "$SCRIPT_DIR/init_schema.py" "$SCRIPT_DIR/schema.sql"
