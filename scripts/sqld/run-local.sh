#!/usr/bin/env bash
# Start/stop/status a local sqld instance — the tool-catalog host.
#   - toolcatalog (127.0.0.1:8084 / hrana 8085) — planner tool-catalog DB
# This instance IS the catalog database (Turso is retired — the free tier
# cannot absorb the per-device replica bootstrap). Public exposure for remote
# clients goes through a cloudflared/tailscale tunnel in front of 127.0.0.1:8084.
# Auth: Ed25519 JWT (see CREDENTIALS.md §2). Point an app at it via
# KAWAI_TURSO_DB_URL=http://127.0.0.1:8084 + KAWAI_TURSO_AUTH_TOKEN=$CATALOG_APP_TOKEN
# (both live in kawai/.env) — and remove that pair afterwards, because a
# second assignment in .env silently overrides the shared-catalog URL.
#
# Start it WITH auth (run-local.sh's plain start skips JWT):
#   set -a; source ~/.kawai/sqld/toolcatalog/tokens.env; set +a
#   SQLD_AUTH_JWT_KEY_FILE=~/.kawai/sqld/toolcatalog/jwt.raw.pub ./run-local.sh start
#
# Usage:
#   ./run-local.sh <db> <cmd>     # db = toolcatalog|all (default: toolcatalog)
#   ./run-local.sh <cmd>          # shorthand for: toolcatalog <cmd>
#   cmd = start|stop|restart|status|logs
set -euo pipefail

BIN="${SQLD_BIN:-$HOME/.local/bin/sqld}"
SCRIPT_DIR="$(cd "$(dirname "$(dirname "$0")")" && pwd)"

# Config (override via SQLD_TOOLCATALOG_* env).
toolcatalog_conf() {
  DATA_DIR="${SQLD_TOOLCATALOG_DATA_DIR:-$HOME/.kawai/sqld/toolcatalog}"
  HTTP_ADDR="${SQLD_TOOLCATALOG_HTTP_ADDR:-127.0.0.1:8084}"
  HRANA_ADDR="${SQLD_TOOLCATALOG_HRANA_ADDR:-127.0.0.1:8085}"
}

db="${1:-toolcatalog}"
cmd="status"
case "$db" in
  toolcatalog|all) cmd="${2:-status}" ;;
  *) cmd="$db"; db="toolcatalog" ;;  # legacy: ./run-local.sh start
esac

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start_one() {
  if is_running; then
    echo "[$db] sqld already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  [[ -x "$BIN" ]] || { echo "sqld binary not found at $BIN (SQLD_BIN to override)" >&2; exit 1; }
  mkdir -p "$DATA_DIR"
  nohup "$BIN" \
    --db-path "$DATA_DIR/data.sqld" \
    --http-listen-addr "$HTTP_ADDR" \
    --hrana-listen-addr "$HRANA_ADDR" \
    >> "$DATA_DIR/sqld.log" 2>&1 &
  echo $! > "$DATA_DIR/sqld.pid"
  for _ in $(seq 1 20); do
    curl -fsS "http://${HTTP_ADDR}/health" >/dev/null 2>&1 && break
    sleep 0.3
  done
  if curl -fsS "http://${HTTP_ADDR}/health" >/dev/null 2>&1; then
    echo "[$db] sqld started (pid $(cat "$DATA_DIR/sqld.pid")) on $HTTP_ADDR"
    echo "[$db] tool-catalog host. Seed/update with: source kawai/.env &&"
    echo "[$db]   KAWAI_TURSO_DB_URL=http://127.0.0.1:8084 KAWAI_TURSO_WRITE_TOKEN=\$KAWAI_TURSO_WRITE_TOKEN \\"
    echo "[$db]   cargo run --manifest-path src-tauri/Cargo.toml --example seed_tool_catalog --features litert,binance,monad,accounting"
  else
    echo "[$db] sqld failed to start — see $DATA_DIR/sqld.log" >&2
    exit 1
  fi
}

stop_one() {
  if is_running; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    echo "[$db] sqld stopped"
  else
    echo "[$db] sqld not running"
    rm -f "$PID_FILE"
  fi
}

status_one() {
  if is_running && curl -fsS "http://${HTTP_ADDR}/health" >/dev/null 2>&1; then
    echo "[$db] sqld running (pid $(cat "$PID_FILE")) on $HTTP_ADDR"
  else
    echo "[$db] sqld not running"
    exit 1
  fi
}

run_one() {
  toolcatalog_conf
  LOG="$DATA_DIR/sqld.log"
  PID_FILE="$DATA_DIR/sqld.pid"
  case "$cmd" in
    start)   start_one ;;
    stop)    stop_one ;;
    restart) stop_one; start_one ;;
    status)  status_one ;;
    logs)    tail -f "$LOG" ;;
    *) echo "usage: $0 [toolcatalog|all] start|stop|restart|status|logs" >&2; exit 1 ;;
  esac
}

case "$db" in
  all) db="toolcatalog"; run_one ;;
  *)   run_one ;;
esac
