# Implementation Plan — DB Token Broker for sqld multi-device sync

Status: **NOT STARTED** — this is the design document. Implementation follows the
phases below. The live status lives in `AGENTS.md` → Roadmap → Open, item #3.

## Decision context

The current DB layer uses `libsql::Builder::new_local(path)` — a single-device
SQLite file, no sync. For multi-device sync, `libsql::Builder::new_remote_replica`
connects to a `sqld` server with an auth token. `sqld` only accepts EdDSA
(Eddsa) tokens; only tokens minted by the kawai backend are accepted.

The EdDSA signing key **must not** ship with the client binary: a leaked key
allows any device to read/write any user's data. Instead the server mints
short-lived tokens after verifying identity (local auth session), and the client
fetches a token before opening the remote replica.

---

## 1. Architecture overview

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          Client (Tauri)                                │
│                                                                        │
│  On boot / token expiry                                                │
│  ┌─────────────────────────────────────────────────────────────┐       │
│  │  db_connection(user_id)                                     │       │
│  │    → build_db(user_id)                                      │       │
│  │      → current_remote_config(user_id)                       │       │
│  │        → if remote: fetch_db_token(user_id)  ←─────────────┼───────│
│  │           → Builder::new_remote_replica(url, token)         │       │
│  │        → if local:  Builder::new_local(path)                │       │
│  └─────────────────────────────────────────────────────────────┘       │
│                        │ HTTPS (TLS)                                   │
│                        ▼                                               │
│  ┌──────────────────────────────────────────────────────────────┐      │
│  │  GET /api/db_token (kawai_session auth)                     │      │
│  └──────────────────────────────────────────────────────────────┘      │
│                        │                                               │
└────────────────────────┼───────────────────────────────────────────────┘
                         │
┌────────────────────────┼───────────────────────────────────────────────┐
│  kawai-web server       │                                              │
│                        │                                               │
│  /api/db_token handler:│                                               │
│    1. Verify identity (local auth session / cookie)                    │
│    2. Extract claims.sub = user_id                                     │
│    3. TokenSigner::mint(user_id, ttl)                                  │
│       → EdDSA JWT { sub, iss:"kawai", exp }                          │
│    4. Return { url: SQLD_URL, token, expires_at }                     │
│                         │                                               │
│  TokenSigner:           │                                               │
│    - Ed25519SigningKey  │                                               │
│    - loaded from KAWAI_DB_SIGNING_KEY env (PEM path)                  │
│    - OR auto-generated + persisted to 0600 file                       │
│    - never leaves server process memory                                │
│                        │                                               │
│  sqld (--enable-namespaces)                                            │
│    → maps token.sub → namespace kawai_{user_id}                       │
│    → each namespace = isolated .db file                               │
│    → rejects any token with wrong/missing signature                    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Token minting — server side

### 2.1 Signing key management

| Env variable | Purpose |
|---|---|
| `KAWAI_DB_SIGNING_KEY` | PEM file path to Ed25519 private key |
| `KAWAI_SQLD_URL` | sqld HTTP endpoint (e.g. `http://localhost:8080`) |

Key loading rules:

1. `KAWAI_DB_SIGNING_KEY` is set → load PEM from that path; **refuse** if file
   permissions are `> 0600`.
2. Not set, web mode (`--features web`) → **fatal error**: key is mandatory in
   server mode.
3. Not set, desktop-only mode → minting is disabled; local-only DB is used
   (current behavior, unchanged).

### 2.2 `TokenSigner` struct

Location: `crates/foundation/auth/src/signer.rs`

```rust
pub struct TokenSigner {
    encoding_key: jsonwebtoken::EncodingKey,
    signing_key: ed25519_dalek::SigningKey,
}

impl TokenSigner {
    /// Load from PEM file (KAWAI_DB_SIGNING_KEY).
    pub fn from_pem_file(path: &Path) -> Result<Self, AuthError>;

    /// Mint an EdDSA JWT.
    /// - sub = user_id
    /// - iss = "kawai"
    /// - exp = now + ttl_secs (max 86400, default 900)
    /// - iat = now
    pub fn mint(&self, user_id: &str, ttl_secs: u64) -> Result<(String, i64), AuthError>;
}
```

JWT payload:

```json
{
  "sub": "<user email>",
  "iss": "kawai",
  "iat": 1735689600,
  "exp": 1735690500,
  "nbf": 1735689600
}
```

Algorithm: `EdDSA` (`jwt::Algorithm::EdDSA`). The public key in the JWK
endpoint is what `sqld` uses to verify; no JWK endpoint is needed on kawai-web
because `sqld` has its own verification.

### 2.3 `/api/db_token` route

Location: `src-tauri/src/web.rs` (behind `#[cfg(feature = "web")]`, protected router)

```rust
async fn db_token_handler(
    Extension(user_id): Extension<String>,
    Extension(signer): Extension<TokenSigner>,
) -> Json<DbTokenResponse> {
    let (token, expires_at) = signer.mint(&claims.sub, 900)?;
    Json(DbTokenResponse {
        url: std::env::var("KAWAI_SQLD_URL").unwrap_or_default(),
        token,
        expires_at,
    })
}

#[derive(Serialize)]
struct DbTokenResponse {
    url: String,
    token: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}
```

- Protected by `auth_middleware` (local session cookie validation).
- `expires_at` is Unix epoch seconds; client uses this to schedule refresh.

---

## 3. Client integration

### 3.1 Remote DB config thread-local

Location: `crates/foundation/db/src/db.rs`

```rust
use std::cell::RefCell;

thread_local! {
    static REMOTE_CONFIG: RefCell<Option<RemoteDbConfig>> = RefCell::new(None);
}

pub struct RemoteDbConfig {
    pub url: String,
    pub token: String,
    pub expires_at: i64,  // Unix epoch
}

/// Inject remote DB config (called after db_token op succeeds).
pub fn set_remote_config(config: Option<RemoteDbConfig>);

/// Current remote config. Returns None when not configured or token expired.
pub fn current_remote_config(user_id: &str) -> Option<RemoteDbConfig>;
```

### 3.2 `build_db` modification

```rust
async fn build_db(user_id: &str) -> Result<libsql::Database, DbError> {
    let dir = user_data_dir(user_id);
    std::fs::create_dir_all(&dir)?;

    // Remote replica path: token is valid for at least 60 more seconds
    if let Some(config) = current_remote_config(user_id) {
        if config.expires_at > unix_now() as i64 + 60 {
            return libsql::Builder::new_remote_replica(
                &config.url,
                config.token.clone(),
            ).build().await.map_err(DbError::from);
        }
        // Token expiring soon — fall through to local; caller triggers refresh
    }

    // Local fallback (always works, no network needed)
    let file = dir.join("kawai.db");
    Ok(libsql::Builder::new_local(file).build().await?)
}
```

### 3.3 Token refresh logic

Location: `src-tauri/src/commands.rs` or `src-tauri/src/logic.rs`

```rust
/// Fetch a fresh db_token from the server and inject into thread-local.
/// Returns Err if: not in web mode, no local session, or server error.
pub async fn refresh_db_token(user_id: &str) -> Result<(), String>;
```

Called:
1. On `set_session` success (first auth).
2. On re-login after an app relaunch (sessions are in-memory).
3. Background: when `expires_at < now + 60`, fetch before next `db_connection`.

### 3.4 `db_token` Tauri command + Axum route

```rust
// commands.rs (desktop, calls server or local)
#[tauri::command]
pub async fn db_token(session: State<'_, Session>) -> Result<DbTokenResponse, String>;

// web.rs (web server, self-contained)
async fn db_token_handler(...) -> Json<DbTokenResponse>;
```

---

## 4. sqld configuration

### 4.1 Namespace mode

```bash
sqld \
  --enable-namespaces \
  --http-listen-addr 0.0.0.0:8080 \
  --auth-jwt-issuer kawai \
  --auth-jwt-public-key-file /path/to/ed25519_public.pem
```

Key flags:
- `--enable-namespaces`: each token `sub` → isolated namespace `kawai_{sub}.db`
- `--auth-jwt-issuer kawai`: only accept tokens with `iss == "kawai"`
- `--auth-jwt-public-key-file`: Ed25519 public key in PEM format

### 4.2 Namespace mapping

| Token `sub` | sqld namespace | Physical file |
|---|---|---|
| `user-abc-123` | `kawai_user-abc-123` | `<sqld-data>/kawai_user-abc-123.db` |
| `user-def-456` | `kawai_user-def-456` | `<sqld-data>/kawai_user-def-456.db` |

Authorization: token from user A can **never** read namespace of user B.
This is enforced by sqld itself, not by application code.

### 4.3 Key generation (one-time)

```bash
# Generate Ed25519 keypair
openssl genpkey -algorithm ED25519 -out db-signing-key.pem
openssl pkey -in db-signing-key.pem -pubout -out db-signing-public.pem

# Set permissions
chmod 600 db-signing-key.pem   # private key
chmod 644 db-signing-public.pem # public key (for sqld)

# Deploy:
# private key → KAWAI_DB_SIGNING_KEY=/path/to/db-signing-key.pem (server env)
# public key  → --auth-jwt-public-key-file=/path/to/db-signing-public.pem (sqld)
```

---

## 5. Feature flag and fallback

### 5.1 Activation

- `KAWAI_SQLD_URL` is set → remote DB is enabled; client fetches token on auth.
- Not set → current behavior unchanged (local-only, zero migration cost).
- This is a **single env var kill switch**: no code changes needed to disable.

### 5.2 Local fallback

- When token expires or network fails → `build_db` falls through to local file.
- Background refresh attempts to restore remote connectivity.
- This ensures **offline operation always works** (core invariant).

### 5.3 Data migration (first run)

For users with existing local DBs who enable sqld:

1. Start sqld with namespaces enabled.
2. Run `sqld --import kawai_<user_id>.db <path/to/existing/kawai.db>` once.
3. Client automatically starts using remote replica.

Automation: a `db_migrate_to_sqld` command can be added to kawai-web for
batch migration during rollout.

---

## 6. Tests

### 6.1 Unit tests

| Test | Location | What it verifies |
|---|---|---|
| `token_signer_mint_and_verify` | `crates/foundation/auth/tests/` | mint → decode round-trip |
| `token_signer_rejects_expired` | same | expired token → error |
| `token_signer_rejects_wrong_issuer` | same | `iss != "kawai"` → error |
| `token_signer_refuses_weak_permissions` | same | file mode > 0600 → panic |
| `build_db_uses_remote_when_configured` | `crates/foundation/db/tests/` | remote config active → `new_remote_replica` |
| `build_db_falls_back_to_local` | same | token expired → `new_local` |

### 6.2 Integration tests

| Test | What it verifies |
|---|---|
| `db_token_endpoint_returns_valid_token` | `/api/db_token` → EdDSA JWT decodable |
| `db_token_requires_auth` | missing/invalid session cookie → 401 |
| `sqld_namespace_isolation` | user A token cannot read user B namespace |
| `token_refresh_before_expiry` | background loop mints new token when `expires_at - now < 60` |
| `offline_fallback` | sqld unreachable → local file used transparently |

### 6.3 Smoke gate addition

```sh
# In .github/workflows/ci.yml, add to the web job:
- name: db-token integration test
  run: |
    # Start sqld in-memory (no disk)
    sqld --enable-namespaces --http-listen-addr 127.0.0.1:8080 \
      --auth-jwt-issuer kawai --auth-jwt-public-key-file tests/ed25519_test_pub.pem &
    sleep 2
    # Generate test signing key
    openssl genpkey -algorithm ED25519 -out /tmp/test-key.pem
    KAWAI_DB_SIGNING_KEY=/tmp/test-key.pem KAWAI_SQLD_URL=http://127.0.0.1:8080 \
      cargo test -p kawai-auth --test signer
```

---

## 7. Security considerations

| Threat | Mitigation |
|---|---|
| Private key leaked | File permissions (0600); key never leaves server process; refuse if perms wrong |
| Token replay | Short TTL (15 min default, max 24h); sqld validates `exp` on every request |
| Cross-user access | sqld namespace isolation: `sub` → namespace; enforced by sqld, not app code |
| MITM on token transfer | HTTPS required between client ↔ kawai-web and client ↔ sqld |
| Local DB theft | Device-level encryption (future, item #4 in AGENTS.md roadmap) |
| sqld compromise | User data encrypted at rest (sqld feature); per-user DB file separation |

---

## 8. Deployment sequence

### Phase 1 — server-side (no client changes)

1. Generate Ed25519 keypair; deploy to server.
2. Start sqld with `--enable-namespaces`.
3. Set `KAWAI_DB_SIGNING_KEY` + `KAWAI_SQLD_URL` in server env.
4. Implement + test `/api/db_token` endpoint.
5. Run unit tests + integration tests against real sqld.

### Phase 2 — client integration (opt-in)

1. Add `RemoteDbConfig` thread-local + token refresh logic.
2. Modify `build_db` to check `current_remote_config`.
3. Add `db_token` command/route for desktop clients.
4. Feature flag: remote DB only when `KAWAI_SQLD_URL` is set.
5. Run smoke tests; verify offline fallback.

### Phase 3 — rollout

1. Deploy to production kawai-web + sqld.
2. Existing users keep local DB (no migration forced).
3. New users / opt-in users: `KAWAI_SQLD_URL` enabled → data syncs.
4. Batch migration tool: `db_migrate_to_sqld` for users who opt in.
5. Monitor token refresh success rate + sqld latency.
6. Enable remote DB by default (remove opt-in flag) after stability window.

---

## 9. Open questions

1. **sqld namespace `sub` format**: does sqld accept arbitrary UTF-8 `sub` as
   namespace name, or must it be a URL-safe identifier? May need hex-encoding
   in `token_signer.mint`.

2. **Conflict resolution**: when device A and B edit offline, the last write
   wins (libsql default). Is this acceptable, or do we need CRDTs? For MVP:
   last-write-wins with clear error messaging on conflict.

3. **Embedded replica vs HTTP replica**: `new_remote_replica` creates a full
   HTTP replica (no local cache). `new_local_replica` embeds a read-only
   copy with periodic sync. Which model fits kawai? HTTP replica is simpler;
   local replica is faster offline. Decision: HTTP replica first (simpler);
   local replica is a follow-up optimization.

4. **sqld version and hosting**: self-hosted sqld on the same server as
   kawai-web? Or managed (libsql.cloud)? Self-hosted is simpler for now.

5. **Client connection pooling**: `db_connection` opens per-op. For remote
   replicas, connection overhead is higher. Pool is deferred to phase 2
   (follow-up after MVP sync works).
