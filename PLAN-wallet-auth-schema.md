# PLAN — Wallet (SIWE) Auth Schema Supabase

Status: **implemented** (see Verification section). Follow-up shipped in the same effort: the **in-app EVM hot-wallet SIWE login** (`monad_wallet_*` ops + "EVM Wallet" button in `auth-gate.tsx`) — see AGENTS.md → Authentication. Still open: asymmetric JWT signing in the Supabase Dashboard (backend JWKS verifier rejects SIWE tokens until enabled).
Target: Supabase project `mpencmdcjzfoahbuepwu` (kawai auth issuer: `https://mpencmdcjzfoahbuepwu.supabase.co/auth/v1`)
Metode: **psql dengan DSN dari `kawai/.env`** (bukan SQL Editor): `psql -h db.mpencmdcjzfoahbuepwu.supabase.co -p 5432 -U postgres -d postgres`, password via `PGPASSWORD` dari file env. Fallback bila DNS/IPv6 bermasalah: **Supavisor pooler** `aws-0-ap-southeast-1.pooler.supabase.com:6543`, user `postgres.mpencmdcjzfoahbuepwu`.

## State awal (diverifikasi via psql)

- `public` schema **kosong** — tabel `profiles` belum ada.
- `auth.users`: 1 user (email-based, `raw_user_meta_data` hanya `email/email_verified/phone_verified/sub`) — belum ada wallet.
- Extension tersedia: `pgcrypto`. `citext` belum terpasang (tidak dipakai; normalisasi lowercase via CHECK constraint).

## Desain

```
auth.users (Supabase Auth, termasuk user SIWE/wallet)
   │  id (uuid, FK on delete cascade)
   ▼
public.profiles
   ├── id              uuid PK → auth.users(id)
   ├── wallet_address  text UNIQUE, CHECK lowercase EVM (0x + 40 hex)
   ├── username        text nullable
   └── created_at      timestamptz default now()
```

Keputusan penting (dari analisis):

1. **Wallet dinormalisasi lowercase** di level DB (`CHECK wallet_address ~ '^0x[0-9a-f]{40}$'`) — checksum EIP-55 tidak masuk DB, hanya di UI. Mencegah duplikat alamat yang sama dengan casing beda.
2. **Auto-provision via trigger** `on_auth_user_created` → `handle_new_user()` (`SECURITY DEFINER`, `search_path = public`): setiap user baru (termasuk hasil SIWE `signInWithWeb3`) langsung dapat baris `profiles`, membaca `raw_user_meta_data->>'wallet_address'`.
3. **RLS penuh**: SELECT/UPDATE dibatasi `auth.uid() = id`. Tidak ada policy INSERT/DELETE untuk role anon/authenticated — insert hanya lewat trigger (definer), delete cascade dari `auth.users`.
4. Semua DDL **idempotent** (`IF NOT EXISTS` / blok `DO $$`) agar aman dijalankan ulang.
5. Additive-only — tidak ada DROP table/data existing.

## Migrasi (dieksekusi via psql)

1. Buat tabel `public.profiles` (+ index unik `wallet_address`).
2. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
3. Policy: `profiles_select_own` (SELECT), `profiles_update_own` (UPDATE with check).
4. Function `public.handle_new_user()` + trigger `on_auth_user_created` on `auth.users`.
5. Backfill: untuk user existing yang punya wallet_address di metadata (saat ini tidak ada — no-op).

## Out of scope (separate work)

- ~~SIWE flow frontend~~ — shipped as the in-app hot wallet (see status above); WalletConnect was evaluated and deferred (analysis: deep-link wallets lack deterministic sign-callbacks on desktop).
- **Asymmetric JWT signing key** in the Supabase Dashboard — REQUIRED for SIWE: the `auth::Verifier` (JWKS) verifier rejects SIWE-issued tokens until enabled.
- RLS untuk tabel aplikasi lain (sessions/messages dsb. ada di SQLite lokal, bukan Supabase).

## Cara kerja (diagram)

### Login via EVM Wallet (SIWE, in-app hot wallet)

```
 Frontend (auth-gate.tsx)          Backend Rust (Tauri/Axum)              OS Keychain         Supabase
 ─────────────────────────         ─────────────────────────              ───────────         ────────
 klik "EVM Wallet"
        │
        │ invoke monad_wallet_create
        ├─────────────────────────> logic::monad_wallet::create()
        │                            │ keychain kosong?
        │                            ├─ ya → kawai_monad::generate_wallet()
        │                            │        (secp256k1, OS CSPRNG)
        │                            ├─ simpan secret ──────────────────> monad-wallet/device
        │                            │  (secret TIDAK pernah ke frontend)
        │<──────── address only ─────┤
        │
        │ compose EIP-4361 message
        │ (domain, nonce, chain 10143)
        │
        │ invoke monad_wallet_sign_message {message}
        ├─────────────────────────> logic::monad_wallet::sign_message()
        │                            │ load secret <────────────────────── monad-wallet/device
        │                            │ EIP-191 personal_sign (in-process)
        │<── 0x + 65-byte sig ───────┤
        │
        │ supabase.auth.signInWithWeb3({chain:'ethereum', message, signature})
        ├────────────────────────────────────────────────────────────────────────────────────>
        │                             ecrecover → address = identitas
        │                             JWT session (asymmetric signing)
        │<────────────────────────────────────────────────────────────────────────────────────┤
        │
        │ onAuthStateChange(SIGNED_IN)
        │ invoke set_session {token}
        ├─────────────────────────> auth::Verifier (JWKS, iss/exp)
        │                            │ valid → set State<Session>
        │                            └ simpan token ─────────────────────> session-token
```

Register dan login adalah aksi yang sama: pemanggilan pertama membuat wallet + user Supabase
baru; pemanggilan berikutnya memakai wallet yang ada → user yang sama (Supabase mengidentifikasi
user dari address hasil ecrecover).

### Provisioning profil (trigger)

```
 auth.users INSERT (user SIWE baru)
        │
        └─ trigger on_auth_user_created → handle_new_user()  [SECURITY DEFINER]
             insert public.profiles (id, lower(wallet_address dari raw_user_meta_data))
             RLS: user hanya bisa SELECT/UPDATE barisnya sendiri (auth.uid() = id)
```

## Verification (hasil psql)

- [x] `\d public.profiles` — kolom + constraint `profiles_wallet_address_format` + unik `profiles_wallet_address_key`.
- [x] `relrowsecurity = true` pada `public.profiles`.
- [x] `pg_policies`: 2 baris (`profiles_select_own`, `profiles_update_own`).
- [x] Trigger `on_auth_user_created` terdaftar di `auth.users`.
- [x] `select count(*) from public.profiles` — 0 (backfill no-op, 1 user existing belum punya wallet).
- [x] Diverifikasi ulang via **direct connection** (`db.<ref>.supabase.co:5432`) — state identik.
