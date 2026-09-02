#!/usr/bin/env bash
set -euo pipefail

# reset-auth.sh — Wipe local login credentials so the auth flow can be tested
# from a clean slate. Routine dev tooling for the wallet/SIWE login work.
#
# Clears (with confirmation / flags):
#   1. Backend session token  — macOS keychain, service "pro.kawai.app",
#      account "session-token"   (written by set_session → keychain.rs)
#   2. Supabase session       — WKWebView localStorage/cookies for the app
#   3. Device hot wallet      — keychain account "monad-wallet/device"
#      (only with --wallet; without it the existing wallet/login maps to the
#       same Supabase user on the next sign-in)
#   4. Per-user local data    — ~/Library/Application Support/pro.kawai.app
#      (only with --data; DESTRUCTIVE: chat history, knowledge, docs)
#
# Usage:
#   bash scripts/reset-auth.sh              # session + webview storage
#   bash scripts/reset-auth.sh --wallet     # + device hot wallet
#   bash scripts/reset-auth.sh --data       # + ALL local app data (destructive)
#   bash scripts/reset-auth.sh --yes        # no confirmation prompt

ASSUME_YES=0
RESET_WALLET=0
RESET_DATA=0
for arg in "$@"; do
  case "$arg" in
    --yes)    ASSUME_YES=1 ;;
    --wallet) RESET_WALLET=1 ;;
    --data)   RESET_DATA=1 ;;
    *) echo "unknown flag: $arg" && exit 1 ;;
  esac
done

SERVICE="pro.kawai.app"
APP_SUPPORT="$HOME/Library/Application Support/$SERVICE"
WEBKIT_DIRS=( "$HOME/Library/WebKit/$SERVICE" "$HOME/Library/WebKit/pro.kawai.app" )

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

delete_keychain_item() {
  local acct="$1" label="$2"
  if security find-generic-password -s "$SERVICE" -a "$acct" >/dev/null 2>&1; then
    security delete-generic-password -s "$SERVICE" -a "$acct" >/dev/null
    echo "  removed keychain item: $label"
  else
    echo "  not present:           $label"
  fi
}

echo "== 1. backend session token (keychain: $SERVICE / session-token) =="
delete_keychain_item "session-token" "session token"

echo "== 2. Supabase session (webview localStorage/cookies) =="
found_webkit=0
for d in "${WEBKIT_DIRS[@]}"; do
  if [ -d "$d" ]; then
    confirm "  delete $d ?" && rm -rf "$d" && echo "  removed: $d"
    found_webkit=1
  fi
done
[ "$found_webkit" -eq 0 ] && echo "  no webview data dirs found"

if [ "$RESET_WALLET" -eq 1 ]; then
  echo "== 3. device hot wallet (keychain: $SERVICE / monad-wallet/device) =="
  delete_keychain_item "monad-wallet/device" "device hot wallet"
fi

if [ "$RESET_DATA" -eq 1 ]; then
  echo "== 4. per-user local data (DANGEROUS) =="
  if [ -d "$APP_SUPPORT" ]; then
    echo "  contents: $(ls "$APP_SUPPORT" | tr '\n' ' ')"
    confirm "  delete ALL of $APP_SUPPORT ?" && rm -rf "$APP_SUPPORT" && echo "  removed: $APP_SUPPORT"
  else
    echo "  not present: $APP_SUPPORT"
  fi
fi

echo
echo "done. next: bun tauri dev → klik "EVM Wallet" pada layar login."
