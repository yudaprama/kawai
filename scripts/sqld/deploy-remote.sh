#!/usr/bin/env bash
# Provision a remote VPS to host the squawk sqld — same binary, same schema,
# same pipeline as local (run-local.sh). Idempotent: safe to re-run for upgrades.
#
# Prereqs on THIS machine: ssh access to the target host.
#   ./deploy-remote.sh user@host
#
# After provisioning, the store points at it via:
#   KAWAI_SQUAWK_DB_URL=https://<host>   (in kawai .env)
#
# What it does on the remote host:
#   1. Downloads the sqld release binary (linux aarch64/x86_64, auto-detected)
#   2. Installs to /usr/local/bin/sqld, data dir /var/lib/kawai-sqld
#   3. Generates an Ed25519 JWT auth secret (once) so the server is NOT open
#   4. Installs a systemd unit (auto-restart, survives reboot)
#   5. Applies schema.sql over HTTP
#
# NOTE on TLS: sqld serves plain HTTP. Terminate TLS in front (Caddy is the
# zero-config default — this script sets it up if caddy is installed; nginx
# works too). For a quick start behind an SSH tunnel, set
# KAWAI_SQUAWK_DB_URL=http://127.0.0.1:8082 with `ssh -L 8082:127.0.0.1:8082`.
set -euo pipefail

REMOTE="${1:?usage: $0 user@host}"
SQLD_VERSION="${SQLD_VERSION:-v0.24.32}"
DATA_DIR="/var/lib/kawai-sqld"
HTTP_PORT="${HTTP_PORT:-8082}"

echo "==> provisioning $REMOTE (sqld $SQLD_VERSION)"

ssh "$REMOTE" bash -s <<REMOTE_SCRIPT
set -euo pipefail
ARCH=\$(uname -m)
case "\$ARCH" in
  x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
  aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
  *) echo "unsupported arch: \$ARCH" >&2; exit 1 ;;
esac

echo "==> installing sqld \$TARGET $SQLD_VERSION"
TMP=\$(mktemp -d)
curl -fsSL "https://github.com/tursodatabase/libsql/releases/download/libsql-server-${SQLD_VERSION}/libsql-server-\${TARGET}.tar.gz" -o "\$TMP/sqld.tar.gz"
tar -xzf "\$TMP/sqld.tar.gz" -C "\$TMP"
sudo install -m 0755 "\$TMP"/sqld*/sqld /usr/local/bin/sqld
rm -rf "\$TMP"
sqld --version

echo "==> data dir + JWT auth secret"
sudo mkdir -p "$DATA_DIR"
sudo chown "\$USER":"\$USER" "$DATA_DIR"
if [[ ! -f "$DATA_DIR/jwt-secret.pem" ]]; then
  # sqld expects an Ed25519 public key for JWT verification; generate the
  # pair, keep the private half OFF the server (tokens are signed elsewhere).
  openssl genpkey -algorithm ed25519 -out "$DATA_DIR/jwt-secret.pem" 2>/dev/null
  echo "JWT secret generated at $DATA_DIR/jwt-secret.pem"
fi

echo "==> systemd unit"
sudo tee /etc/systemd/system/kawai-sqld.service > /dev/null <<UNIT
[Unit]
Description=kawai squawk DB (sqld)
After=network-online.target
Wants=network-online.target

[Service]
User=\$USER
ExecStart=/usr/local/bin/sqld \\
  --db-path $DATA_DIR/data.sqld \\
  --http-listen-addr 127.0.0.1:${HTTP_PORT} \\
  --auth-jwt-keys $DATA_DIR/jwt-secret.pem
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now kawai-sqld
sleep 1
systemctl is-active kawai-sqld
REMOTE_SCRIPT

echo "==> applying schema"
SQLD_URL="http://127.0.0.1:${HTTP_PORT}" "$SCRIPT_DIR/init-schema.sh" || true
# schema goes through an SSH tunnel since sqld binds 127.0.0.1 on the remote:
ssh -f -N -L 18082:127.0.0.1:${HTTP_PORT} "$REMOTE"
SQLD_URL="http://127.0.0.1:18082" "$SCRIPT_DIR/init-schema.sh"
kill %1 2>/dev/null || true

echo
echo "Done. Next steps:"
echo "  1. Put TLS in front (Caddy reverse_proxy 127.0.0.1:${HTTP_PORT}) or use SSH tunnel."
echo "  2. Sign a JWT with the private half of $DATA_DIR/jwt-secret.pem (kept OFF the server),"
echo "     then set in kawai .env:"
echo "        KAWAI_SQUAWK_DB_URL=https://<host>"
echo "  3. Migrate history from Turso (one-off dump/restore) if needed."
