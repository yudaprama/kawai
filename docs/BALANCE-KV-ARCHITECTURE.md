# Balance & KV Architecture — Worker ⇄ Supabase

**Tanggal:** 2026-09-02
**Status:** ✅ Live & terverifikasi end-to-end di project test
**Project Supabase:** `mpencmdcjzfoahbuepwu` (ap-southeast-1)
**Worker:** `https://kawai-worker.akuntestinguntukseto.workers.dev`

Dokumen ini menggantikan peran modul balance/billing di `x/store` (Go, Cloudflare
KV via REST API) dengan arsitektur Supabase-first + Cloudflare Worker (Rust/WASM).

---

## 1. Keputusan arsitektur

### 1.1 Partisi data — TIDAK ADA CACHE

Setiap data hidup di **satu** tempat (source of truth tunggal). Tidak ada cache
→ tidak ada invalidation yang perlu di-maintain.

| Data | Source of truth | Alasan |
|---|---|---|
| **Saldo, ledger, debt** | 🔒 Supabase (Postgres) | Uang — butuh ACID & atomic debit |
| **Settlement, Merkle, claim** (rencana) | 🔒 Supabase | Transactional, agregasi SQL |
| **API key** (`apikey:`, `authz:`) | ✅ KV worker | Write-once, delete saat revoke |
| **Marketplace ephemeral** | ✅ KV worker | TTL native, expire sendiri |
| **Presence/heartbeat** (`online:{addr}`) | ✅ KV worker | TTL 120s = kebenaran; expire = offline |
| **Idempotency window** (`seen:{id}`) | ✅ KV worker | Dedup jendela pendek; ledger tetap di Supabase |

Kriteria data yang boleh jadi source of truth di KV:
1. **Bukan uang** (bukan saldo/ledger/debt)
2. **Toleran kehilangan** (re-register, bukan rugi finansial)
3. **Immutable atau self-expiring** (TTL)

### 1.2 Kenapa billing TIDAK bisa client → Edge Function langsung

Client yang menentukan jumlah tagihan = tidak ada tagihan:
- client bisa **skip** pemanggilan debit,
- client bisa **manipulasi `amount`**,
- JWT hanya membuktikan *siapa*, bukan *berapa* pemakaiannya.

Nilai tagihan hanya diketahui server yang melayani → **worker yang menagih**.
Client hanya boleh: baca saldo (`get-my-balance`) dan credit terkontrol
(`credit_my_balance`, reason whitelist, hanya menambah).

### 1.3 Admin client → Edge Function: BOLEH

Admin panel memanggil `debit-balance` langsung dengan JWT admin
(`app_metadata.role = 'admin'` — **bukan** `user_metadata`, itu bisa diedit user).
Koreksi manual wajib `reason='manual'` + `admin_id` tercatat di ledger `ref`.

---

## 2. Arsitektur final

```
client (user)
  │  Authorization: Bearer <JWT user>
  │
  ├── POST /transfer ──────────→ Cloudflare Worker (Rust/WASM)
  │                               ├─ verifikasi JWT via JWKS (auth.rs)
  │                               ├─ alloy: sign EIP-1559 → Monad RPC
  │                               └─ [rencana] billing hook → EF debit-balance
  │
  ├── GET /balance/:address ───→ Worker → KV `balance:{addr}`
  │
  └── POST /functions/v1/get-my-balance ──→ EF → RPC public.get_my_balance
                                                   └→ private.user_balances

worker (server, billing)
  └── POST /functions/v1/debit-balance
        Authorization: Bearer <anon key>   (sekadar utk gateway)
        x-worker-secret: <WORKER_FN_SECRET> (auth sebenarnya)
        └─→ RPC public.debit_balance (SECURITY DEFINER, atomic)
              ├─ UPDATE ... WHERE usdt_balance >= amount   ← atomic guard
              ├─ INSERT private.balance_ledger             ← append-only audit
              └─ gagal → EF panggil public.record_debt

admin panel
  └── POST /functions/v1/debit-balance
        Authorization: Bearer <JWT admin>   (app_metadata.role='admin')
        └─→ RPC sama, reason dipaksa 'manual' + admin_id di ledger ref
```

---

## 3. Komponen

### 3.1 Database (`kawai/supabase/migrations/`)

**`20260315000001_balance_system.sql`** — schema `private` (TIDAK terekspos
Data API; token user tidak punya jalur akses sama sekali):

| Tabel | Isi |
|---|---|
| `private.user_balances` | saldo per user (micro-USDT bigint, non-negatif), `trial_claimed` |
| `private.balance_ledger` | append-only: setiap delta + `balance_after` + `reason` + `ref` jsonb |
| `private.balance_debts` | debt saat debit gagal setelah layanan terpakai |

**`20260315000002_rpc_public.sql`** — RPC di schema `public` (PostgREST hanya
expose `public`; **tabel tetap di `private`**):

| RPC | Grant | Guard di body |
|---|---|---|
| `get_my_balance()` | authenticated | `auth.uid()` — hanya dirinya |
| `credit_my_balance(amount, reason)` | authenticated | hanya menambah; reason ∈ {trial, deposit_claim} |
| `debit_balance(user_id, amount, reason, admin_id?)` | service_role + authenticated | 3 jalur: service_role (siapa pun), user (dirinya), admin (role check `auth.jwt()`, wajib reason='manual' + admin_id) |
| `record_debt(user_id, amount, reason)` | service_role | — |

⚠️ `EXECUTE` di-REVOKE dari `public`/`anon` (Postgres grant EXECUTE ke PUBLIC
secara default). RLS on di semua tabel (defense in depth).

### 3.2 Edge Functions (`kawai/supabase/functions/`)

**`debit-balance`** (`verify_jwt = false`) — dua jalur auth:
1. **Worker:** `Authorization: Bearer <anon key>` (untuk gateway) +
   `x-worker-secret: <WORKER_FN_SECRET>` → path service_role, reason bebas,
   auto `record_debt` saat debit gagal (409 `insufficient_balance`).
2. **Admin:** `Authorization: Bearer <JWT admin>` → diverifikasi eksplisit ke
   `/auth/v1/user` (signature+exp, karena verify_jwt=false), role dicek dari
   `app_metadata`, reason dipaksa `'manual'`.

**`get-my-balance`** — pass-through tipis; JWT user diteruskan ke RPC,
`auth.uid()` di DB yang memutuskan.

Kenapa secret worker di header custom: gateway platform menuntut header
`Authorization` terisi (error `UNAUTHORIZED_NO_AUTH_HEADER` kalau kosong),
dan secret hex bukan JWT.

### 3.3 Cloudflare Worker (Rust) (`kawai/contracts/worker/`)

**`src/kvstore.rs`** — `KVStore` di atas KV binding `KV`
(namespace `KAWAI_WORKER`, id `68b0a930665b4844bb3bc7e9965b40b8`,
terisolasi dari namespace lama `x/store`):

- Generic: `get_raw` / `put_raw` / `put_raw_with_ttl` (min 60s) / `delete` / `list_keys`
- Balance (KV): `get_balance`, `credit_balance`, `debit_balance` — ⚠️
  read-modify-write non-atomic; source of truth finansial = Supabase
- API key: dual-write `apikey:{key}` + reverse `authz:{addr}`, dengan rollback
- Marketplace: TTL/ephemeral
- Presence: `heartbeat(addr)` TTL 120s, `list_online`, `is_online`
- Idempotency: `check_and_mark(id, ttl)` — get→put bisa race pada request
  paralel persis bersamaan (acceptable untuk window dedup)

**Endpoint live:**

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| POST | `/transfer` | JWT Supabase + `PRIVATE_KEY` secret | transfer KAWAI (ERC20) |
| POST | `/kv` | ❌ belum ada auth | `{key, value, ttl?}` |
| GET | `/kv/:key` | ❌ belum ada auth | raw value (404 jika absen) |
| GET | `/balance/:address` | ❌ belum ada auth | saldo KV (default 0) |

> ⚠️ Endpoint KV/balance worker **belum ber-auth** — jika akan di-expose,
> tambahkan middleware JWT seperti `/transfer`.

---

## 4. Secrets & konfigurasi

| Secret | Lokasi | Cara set |
|---|---|---|
| `WORKER_FN_SECRET` | Supabase secrets + Worker secret | `supabase secrets set WORKER_FN_SECRET=<hex>` **dan** `echo -n <hex> \| npx wrangler secret put WORKER_FN_SECRET` — **nilai harus sama** |
| `PRIVATE_KEY` | Worker secret saja | `npx wrangler secret put PRIVATE_KEY` — **belum di-set**, `/transfer` error sampai diisi. Hot wallet terpisah! |
| role admin | `auth.users.app_metadata` | Dashboard → Authentication → Users → `{"role":"admin"}` — hanya service yang bisa menulis |
| `KV` binding | `wrangler.toml` | `[[kv_namespaces]]` id `68b0a930665b4844bb3bc7e9965b40b8` |

---

## 4b. Top up (release interim — manual admin)

Model release: saldo = **token credit** (1 token provider = 1 credit, tanpa
konversi USDT). Konversi ke pembayaran nyata disusun belakangan.

```bash
# Top up manual (admin): tambah credit via psql
psql "$DATABASE_URL" -c "
  select private.ensure_balance_row('<user-uuid>');
  update private.user_balances set usdt_balance = usdt_balance + 1000000
   where user_id = '<user-uuid>';"
# (ledger entry manual opsional — rekonsiliasi menyusul)
```

Atau via Edge Function path admin (JWT admin): `POST /functions/v1/debit-balance`
dengan amount negatif tidak didukung — gunakan `credit_my_balance` via psql,
atau tambahkan RPC `admin_credit` nanti.

Kebijakan default: user baru mulai dengan saldo 0 (blockturn sampai admin
memberi credit). Beri saldo awal gratis di migration seed kalau mau.

---

## 5. Deployment runbook

```bash
# ── Supabase ──
cd kawai/supabase
supabase link --project-ref mpencmdcjzfoahbuepwu   # sekali
supabase db push                                    # apply migrations
supabase functions deploy debit-balance
supabase functions deploy get-my-balance
supabase secrets set WORKER_FN_SECRET=<hex>

# ── Cloudflare Worker ──
cd kawai/contracts/worker
cargo check --target wasm32-unknown-unknown   # gate cepat
worker-build --release                        # generate build/worker/shim.mjs
npx wrangler deploy
echo -n <hex-yang-sama> | npx wrangler secret put WORKER_FN_SECRET
npx wrangler secret put PRIVATE_KEY           # sekali (hot wallet)
```

CLI: `supabase` v2.116.0 (login via `supabase login`), `wrangler` via
`bunx wrangler` (OAuth login; token dari `.env` `CLOUDFLARE_API_TOKEN_TUNNEL`
hanya punya izin KV, **tidak cukup** untuk deploy Workers).

---

## 6. Verifikasi yang sudah dilakukan (2026-09-02)

Semua dijalankan nyata terhadap project `mpencmdcjzfoahbuepwu`:

| Test | Hasil |
|---|---|
| Migration ter-apply (2 file) | ✅ `supabase migration list` |
| `anon` akses schema `private` | ✅ ditolak total (level schema) |
| Grant: `anon` tanpa EXECUTE debit; `authenticated` get/credit/debit; `service_role` semua | ✅ `has_function_privilege` |
| RLS on di 3 tabel | ✅ pg_class |
| Debit non-service tanpa JWT | ✅ `forbidden` |
| Debit service_role 400/1000 → 600 | ✅ |
| Over-debit 700 > 600 | ✅ `insufficient balance` (atomic) |
| Ledger + debt tercatat | ✅ |
| **E2E:** EF debit-balance (worker path) → `{"ok":true,"balance":600}` | ✅ HTTP 200 |
| Gateway tanpa/wrong auth → 401/403 | ✅ |
| Worker live: `/kv` put+get, `/balance` default 0 | ✅ |
| Data test di-cleanup | ✅ |

## 7. Gotchas yang sudah ditemukan (jangan diulang)

1. **Urutan migration:** `ALTER TABLE ... ENABLE RLS` sebelum `CREATE TABLE` = error `42P01`.
2. **`service_role` butuh `GRANT USAGE ON SCHEMA private`** — tanpa itu EF path 401, padahal test lokal postgres lolos.
3. **PostgREST hanya expose `public`** — RPC di schema lain = `PGRST202` walau grant benar.
4. **`auth.role()` / `auth.uid()` membaca `request.jwt.claims`** (di-set PostgREST), bukan `current_role` — test psql harus `set_config('request.jwt.claims', '{"role":"service_role"}', true)`.
5. **Supabase secrets list menampilkan nilai ter-mask** — jangan pakai untuk disalin; set ulang dari satu nilai sumber.
6. **KV eventually-consistent ~60s** — api key baru/revoke belum efektif global sesaat. `check_and_mark` idempotency bisa race (worst case 1 duplikat lolos; ledger di Supabase yang menjaga).
7. **`supabase db query` default ke lokal** (Docker) — remote pakai psql + `DATABASE_URL` dari `kawai/.env`, atau MCP Supabase (perlu `supabase_auth`).

## 8. Roadmap

- [x] **Interim (release 2026-09): billing desktop FAIR per-token** —
  crate `crates/foundation/billing` (`kawai-billing`): `bill_usage()` —
  debit dari `RemoteUsage` nyata yang dilaporkan provider (rate:
  `MICROS_PER_1K_TOKENS`), dipanggil di `commands.rs::plan_task` setelah
  plan sukses; `supervisor::plan_task` sekarang mengembalikan usage.
  Frontend (`gateTurn`): desktop = pre-check saldo saja (blokir kalau 0);
  web fallback = flat 0.05 USDT/turn (honor system).
  ⚠️ Tetap bukan kontrol keamanan (user bisa patch binary / skip).
- [ ] Fase 1: key LLM server-issued (runtime fetch via RPC, bukan bundled di
  `kawai_constants::llm`) — menutup vektor ekstraksi key dari binary.
- [ ] Fase 2: metering per-token untuk SELURUH turn (saat ini baru planner
  call yang terukur — step tools lokal tidak ada LLM call per step),
  reserve quota + daily cap server-side di Postgres.
- [ ] Fase 3 (opsional, saat revenue justifikasi): proxy LLM server-side
  untuk penegakan ketat. Worker CF/EF debit yang sudah live tetap dipakai.
- [ ] Auth untuk endpoint `/kv` dan `/balance` worker
- [ ] Migrasi job rewards / referral payout / settlement ke Supabase
- [ ] Set `PRIVATE_KEY` (user, manual)
