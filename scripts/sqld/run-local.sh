#!/usr/bin/env bash
# Start/stop/status a local sqld hosting the squawk DB.
# The SAME sqld binary + schema run on the remote VPS (see deploy-remote.sh),
# so local and prod stay byte-identical apart from the bind address.
#
# Usage:
#   ./run-local.sh start|stop|restart|status|logs
set -euo pipefail

BIN="${SQLD_BIN:-$HOME/.local/bin/sqld}"
DATA_DIR="${SQLD_DATA_DIR:-$HOME/.kawai/sqld/squawk}"
DB_PATH="$DATA_DIR/data.sqld"
LOG="$DATA_DIR/sqld.log"
PID_FILE="$DATA_DIR/sqld.pid"
HTTP_ADDR="${SQLD_HTTP_ADDR:-127.0.0.1:8082}"
HRANA_ADDR="${SQLD_HRANA_ADDR:-127.0.0.1:8083}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cmd="${1:-status}"

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if is_running; then
    echo "sqld already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  [[ -x "$BIN" ]] || { echo "sqld binary not found at $BIN (SQLD_BIN to override)" >&2; exit 1; }
  mkdir -p "$DATA_DIR"
  nohup "$BIN" \
    --db-path "$DB_PATH" \
    --http-listen-addr "$HTTP_ADDR" \
    --hrana-listen-addr "$HRANA_ADDR" \
    >> "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in $(seq 1 20); do
    curl -fsS "http://${HTTP_ADDR}/health" >/dev/null 2>&1 && break
    sleep 0.3
  done
  if curl -fsS "http://${HTTP_ADDR}/health" >/dev/null 2>&1; then
    echo "sqld started (pid $(cat "$PID_FILE")) on $HTTP_ADDR"
    echo "schema is provisioned by kawai itself on first use (SquawkStore::ensure_schema)"
  else
    echo "sqld failed to start — see $LOG" >&2
    exit 1
  fi
}

stop() {
  if is_running; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    echo "sqld stopped"
  else
    echo "sqld not running"
    rm -f "$PID_FILE"
  fi
}

status() {
  if is_running && curl -fsS "http://${HTTP_ADDR}/health" >/dev/null 2>&1; then
    echo "sqld running (pid $(cat "$PID_FILE")) on $HTTP_ADDR"
  else
    echo "sqld not running"
    exit 1
  fi
}

case "$cmd" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -f "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|logs" >&2; exit 1 ;;
esac
