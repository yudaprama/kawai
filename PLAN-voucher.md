# PLAN-voucher.md

## Voucher sekali-pakai

Voucher adalah kode sekali-pakai yang bisa ditebus untuk mendapatkan token. Setiap voucher memiliki durasi kedaluwarsa opsional. Admin dapat membuat dan mencabut voucher melalui CLI.

### Wire contract (worker)

| Endpoint | Auth | Body | Response | Errors |
|---|---|---|---|---|
| `POST /topup/voucher/redeem` | user | `{code}` | `{tokens,balance}` | `invalid_code_format`, `voucher_not_found`, `voucher_already_redeemed`, `voucher_revoked`, `voucher_expired` |
| `POST /admin/voucher/issue` | admin | `{tokens,count,note?,expiresAt?}` | `{codes:[{code,tokens}]}` | — |
| `GET /admin/voucher/list` | admin | — | `{items:[{code,tokens,note,expiresAt,used,redeemedAt,revokedAt,createdAt}]}` | — |
| `POST /admin/voucher/revoke` | admin | `{code}` | `{status:"revoked"}` | — |

### Redeem flow

1. Validasi format kode (alphanumeric, max 32 karakter).
2. Cari voucher `WHERE code = ? AND used = FALSE AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
3. Jika tidak ditemukan → `voucher_not_found` / `voucher_already_redeemed` / `voucher_revoked` / `voucher_expired`.
4. Update `vouchers` set `used = TRUE`, `redeemed_at = now()`.
5. Insert `balance_ledger` baris baru dengan `ref = 'voucher:' + code`, `user_id`, `amount = tokens`, `type = 'credit'`.
6. Update `user_balances` (upsert), return `{tokens, balance}`.

**Exactly-once ledger entry**: kode unik `ref = 'voucher:' + code` mencegah double-redemption meski retry client.

### Issue/Revoke flow (CLI-only)

- **Issue**: `scripts/voucher.ts issue --tokens N --count M [--note ...] [--expires ...]`
  - Generate `count` kode hex 32 karakter unik.
  - Insert batch atomik ke `vouchers`.
  - Return array `{code, tokens}`.
- **Revoke**: `scripts/voucher.ts revoke <code>`
  - Set `revoked_at = now()`; kode yang sudah dipakai tidak bisa dicabut.
  - Return `status:"revoked"`.

### DB schema

```sql
CREATE TABLE vouchers (
  code TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL,
  note TEXT,
  expires_at TIMESTAMP,
  used BOOLEAN DEFAULT FALSE,
  redeemed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP,
  deleted_at TIMESTAMP
);
CREATE INDEX idx_vouchers_used ON vouchers(used);
CREATE INDEX idx_vouchers_expires ON vouchers(expires_at);
```

### Migration

```sql
-- 0022_vouchers.sql
CREATE TABLE vouchers (
  code TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL,
  note TEXT,
  expires_at TIMESTAMP,
  used BOOLEAN DEFAULT FALSE,
  redeemed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP,
  deleted_at TIMESTAMP
);
CREATE INDEX idx_vouchers_used ON vouchers(used);
CREATE INDEX idx_vouchers_expires ON vouchers(expires_at);
```

### Frontend (klien)

- Tampil voucher card di halaman Top Up, antara saldo card dan QRIS claim ternary.
- Redeem: input kode → tombol → success/error toast → `topup_balance` refresh.
- Token yang diperoleh langsung mengisi saldo (tidak ada jendela konfirmasi terpisah).

### Konfigurasi hardcoded

- `MAX_VOUCHER_CODE_LEN = 32`
- `VOUCHER_CODE_PATTERN = /^[a-zA-Z0-9]+$/`
- `REF_PREFIX = 'voucher:'`