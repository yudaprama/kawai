#!/usr/bin/env bash
# Start/stop/status local sqld instances.
# Two instances, one binary + pattern:
#   - squawk      (127.0.0.1:8082 / hrana 8083) — market-squawk shared DB
#   - toolcatalog (127.0.0.1:8084 / hrana 8085) — planner tool-catalog DB
# The SAME sqld binary + schema run on the remote VPS for squawk
# (see deploy-remote.sh), so local and prod stay byte-identical apart
# from the bind address.
#
# Usage:
#   ./run-local.sh <db> <cmd>     # db = squawk|toolcatalog|all (default: squawk)
#   ./run-local.sh <cmd>          # shorthand for: squawk <cmd>
#   cmd = start|stop|restart|status|logs
set -euo pipefail

BIN="${SQLD_BIN:-$HOME/.local/bin/sqld}"
SCRIPT_DIR="$(cd "$(dirname "$(dirname "$0")")" && pwd)"

# Per-instance config (override via <PREFIX>_* env, e.g. SQLD_SQUAWK_HTTP_ADDR).
squawk_conf() {
  DATA_DIR="${SQLD_SQUAWK_DATA_DIR:-$HOME/.kawai/sqld/squawk}"
  HTTP_ADDR="${SQLD_SQUAWK_HTTP_ADDR:-127.0.0.1:8082}"
  HRANA_ADDR="${SQLD_SQUAWK_HRANA_ADDR:-127.0.0.1:8083}"
}

toolcatalog_conf() {
  DATA_DIR="${SQLD_TOOLCATALOG_DATA_DIR:-$HOME/.kawai/sqld/toolcatalog}"
  HTTP_ADDR="${SQLD_TOOLCATALOG_HTTP_ADDR:-127.0.0.1:8084}"
  HRANA_ADDR="${SQLD_TOOLCATALOG_HRANA_ADDR:-127.0.0.1:8085}"
}

db="${1:-squawk}"
cmd="status"
case "$db" in
  squawk|toolcatalog|all) cmd="${2:-status}" ;;
  *) cmd="$db"; db="squawk" ;;  # legacy: ./run-local.sh start
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
    case "$db" in
      squawk)      echo "[$db] schema is provisioned by kawai itself on first use (SquawkStore::ensure_schema)" ;;
      toolcatalog) echo "[$db] seed via (src-tauri/): cargo build --example seed_tool_catalog --features litert,binance,codegraph,monad && ./target/debug/examples/seed_tool_catalog" ;;
    esac
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
  case "$db" in
    squawk)      squawk_conf ;;
    toolcatalog) toolcatalog_conf ;;
  esac
  LOG="$DATA_DIR/sqld.log"
  PID_FILE="$DATA_DIR/sqld.pid"
  case "$cmd" in
    start)   start_one ;;
    stop)    stop_one ;;
    restart) stop_one; start_one ;;
    status)  status_one ;;
    logs)    tail -f "$LOG" ;;
    *) echo "usage: $0 [squawk|toolcatalog|all] start|stop|restart|status|logs" >&2; exit 1 ;;
  esac
}

case "$db" in
  all) for d in squawk toolcatalog; do db="$d" run_one || true; done ;;
  *)   run_one ;;
esac
