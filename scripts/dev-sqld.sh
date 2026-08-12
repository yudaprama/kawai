#!/usr/bin/env sh
# Dev launcher for self-hosted libsql-server (sqld) — the sync target for
# kawai's per-user embedded replicas.
#
# AUTH MODEL (important): sqld validates client JWTs with EdDSA against an
# Ed25519 PUBLIC key (--auth-jwt-key-file). It does NOT support JWKS or RS256,
# so Clerk's session JWTs CANNOT be validated by sqld directly. Instead the
# Rust backend verifies the Clerk identity (public JWKS) and mints short-lived
# EdDSA tokens that sqld accepts. Keys live in $KAWAI_SQLD_DIR/keys.
set -eu
SQLD="${SQLD:-sqld}"
BASE="${KAWAI_SQLD_DIR:-$HOME/.local/var/kawai-sqld}"
PUBKEY="$BASE/keys/sqld_jwt_ed25519_pub.pem"
ADDR="${KAWAI_SQLD_ADDR:-127.0.0.1:8080}"
mkdir -p "$BASE/keys"
if [ ! -f "$PUBKEY" ]; then
  echo "missing $PUBKEY — generating a dev Ed25519 keypair"
  openssl genpkey -algorithm Ed25519 -out "$BASE/keys/sqld_jwt_ed25519.pem"
  openssl pkey -in "$BASE/keys/sqld_jwt_ed25519.pem" -pubout -out "$PUBKEY"
  chmod 600 "$BASE/keys/sqld_jwt_ed25519.pem"
fi
# Add --enable-namespaces for per-user isolation (the multi-tenant target).
exec "$SQLD" --db-path "$BASE" --http-listen-addr "$ADDR" \
  --auth-jwt-key-file "$PUBKEY" --no-welcome "$@"
