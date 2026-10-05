# PLAN-voucher.md

## Voucher sekali-pakai

Voucher adalah kode sekali-pakai 16 karakter (Crockford base32) yang bisa ditebus jadi token. Setiap voucher boleh punya kedaluwarsa opsional. Admin menerbitkan/mencabut voucher lewat CLI; penebusan user lewat kartu Voucher di halaman Top Up.

### Kode

- Alfabet Crockford base32 `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (tanpa I, L, O, U), 16 char — `CODE_ALPHABET` / `CODE_LENGTH` di `kawai-server/worker/src/vouchers.ts`.
- Dibuat dengan `crypto.getRandomValues` + `byte & 31` (uniform karena 32 membagi 256) → ±80 bit entropi. Brute force mustahil — itulah kontrol keamanan utamanya (tanpa rate limit; keputusan desain).
- Normalisasi input user (`normalizeCode`): uppercase → `O`→`0`, `I`/`L`→`1` → buang semua non-`[0-9A-Z]`. Hasil harus tepat 16 char; selain itu `invalid_code_format`.

### Wire contract (worker)

| Endpoint | Auth | Body | Response | Errors |
|---|---|---|---|---|
| `POST /topup/voucher/redeem` | user | `{code}` | `{tokens,balance}` | 400 `invalid_code_format`; 404 `voucher_not_found`; 409 `voucher_already_redeemed` / `voucher_revoked` / `voucher_expired` |
| `POST /admin/voucher/issue` | admin | `{tokens,count,note?,expiresAt?}` | `{codes:[{code,tokens}]}` | 400 `'tokens' must be a positive integer` / `'count' must be 1..100` / `'expiresAt' must be in the future`; 503 `code_pool_exhausted` |
| `GET /admin/voucher/list` | admin | — | `{items:[{code,tokens,status,note,expiresAt,redeemedBy,redeemedAt,createdAt}]}` — terbaru dulu, limit 500 | — |
| `POST /admin/voucher/revoke` | admin | `{code}` | `{status:"revoked"}` | 400 `invalid_code_format`; 404 `voucher_not_found`; 409 `voucher_already_redeemed` / `voucher_revoked` |

Admin = `ADMIN_EMAIL` (konstanta di `kawai-server/worker/src/qris.ts`).

### Redeem flow (`handleRedeem`)

1. `normalizeCode` → kosong → 400 `invalid_code_format`.
2. Pre-read baris **hanya untuk pesan error yang jelas** (urut: 404 `voucher_not_found` → 409 `voucher_already_redeemed` → 409 `voucher_revoked` → 409 `voucher_expired`).
3. Gerbang otoritatif = SATU `DB.batch()` berisi:
   1. `INSERT INTO balance_ledger (email, amount, reason='voucher', ref='voucher:<code>', created_at)` — unique index parsial `balance_ledger_ref` (DDL `billing.ts`) menggerakkan sekali-pakai;
   2. upsert `user_balances` (`tokens = tokens + excluded.tokens`);
   3. `UPDATE vouchers SET redeemed_by, redeemed_at ... WHERE redeemed_at IS NULL` (kosmetik — gugur bersama batch).
4. Unique violation pada `balance_ledger` → SELURUH batch rollback → 409 `voucher_already_redeemed`; saldo tak berubah, retry client aman.
5. Sukses → `{tokens, balance}` (balance dibaca ulang via `getTokens`).

Kenapa bukan conditional UPDATE: statement zero-row di D1 TIDAK menggugurkan batch, jadi unique index-lah penggerbangnya. Jendela revoke-vs-redeem (ms antara pre-read dan batch) diterima — revoke sebaiknya dilakukan sebelum kode diedarkan. Penebusan = satu request sinkron, jadi tidak butuh state machine `pending→crediting→credited` milik QRIS.

### Issue/List/Revoke flow (CLI-only)

- **Issue** (`bun scripts/voucher.ts issue --tokens <n> --count <n> [--note "..."] [--expires YYYY-MM-DD]`): `tokens` integer positif, `count` 1..100, `note` ≤200 char, `expiresAt` unix harus masa depan. Insert per-baris `INSERT ... ON CONFLICT DO NOTHING` (tabrakan PK praktis nol → generate ulang), cap percobaan `count * 10` → 503 `code_pool_exhausted`. Kode dicetak CLI (header + satu kode per baris).
- **List** (`bun scripts/voucher.ts list`): semua kode terbaru dulu (limit 500), kolom `status` (`active`/`revoked`) plus `redeemed_by`/`redeemed_at` untuk audit.
- **Revoke** (`bun scripts/voucher.ts revoke <code>`): CAS `UPDATE ... SET status='revoked' WHERE status='active' AND redeemed_at IS NULL`. Kode terpakai tak tersentuh (uangnya sudah masuk) → 409 `voucher_already_redeemed`.

### DB schema (runtime DDL — `ensureVoucherSchema`, pola qris/billing)

Worker tidak memakai file migration; semua skema D1 dibuat `CREATE TABLE IF NOT EXISTS` saat request pertama:

```sql
CREATE TABLE IF NOT EXISTS vouchers (
  code TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL,
  expires_at INTEGER,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  redeemed_by TEXT,
  redeemed_at INTEGER
);
CREATE INDEX IF NOT EXISTS vouchers_status ON vouchers(status, created_at);
```

Sekali-pakai digerbangi unique index parsial `balance_ledger_ref (ref) WHERE ref IS NOT NULL` — `ref = 'voucher:<code>'` tak pernah bertabrakan dengan `tx_id` QRIS maupun ref `recap:`.

### Frontend (klien)

- Kartu Voucher di halaman Top Up, antara saldo card dan QRIS claim ternary (tetap terlihat saat preview QRIS error 503).
- Input kode (trim + uppercase di klien) → tombol "Tebus voucher" (Enter juga submit) → panel sukses inline (`+N token`, saldo baru) atau panel error inline (teks worker verbatim) — bukan toast.
- Sukses → `refreshTokenBalance()` + reload Riwayat; label `voucher` di `REASON_LABEL` menandai baris ledger-nya.

### Konfigurasi hardcoded

- `CODE_ALPHABET` + `CODE_LENGTH = 16`, `LIST_LIMIT = 500`, `D1_BINDING = "DB"` (`kawai-server/worker/src/vouchers.ts`)
- `ADMIN_EMAIL` (`kawai-server/worker/src/qris.ts`)
- Token admin dibaca dari berkas `auth.token` (pola `scripts/qris.ts`) — tanpa env var baru.
