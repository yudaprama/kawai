# kawai/supabase — balance & billing backend

Source of truth finansial (saldo, ledger, debt). Arsitektur lengkap:
**`kawai/docs/BALANCE-KV-ARCHITECTURE.md`** (wajib baca sebelum mengubah).

## Struktur

```
migrations/
  20260315000001_balance_system.sql  # schema private + tabel + RLS
  20260315000002_rpc_public.sql      # RPC di public (PostgREST hanya expose public)
functions/
  debit-balance/    # dual auth: worker (x-worker-secret) & admin (JWT role=admin)
  get-my-balance/   # baca saldo user (JWT pass-through ke RPC)
config.toml
```

## Prinsip keamanan (ringkas)

- Tabel saldo di schema `private` — **tidak terekspos Data API**; token user
  tidak punya jalur akses langsung.
- User TIDAK bisa debit saldo siapa pun via REST — `debit_balance` di-guard
  role di dalam body (`app_metadata.role='admin'` / `service_role`).
- Semua perubahan saldo tercatat di `balance_ledger` (append-only, audit).

## Deploy

```bash
supabase link --project-ref mpencmdcjzfoahbuepwu   # sekali
supabase db push
supabase functions deploy debit-balance get-my-balance
supabase secrets set WORKER_FN_SECRET=<hex>   # sinkron dgn wrangler secret
```

Gotchas deployment: lihat §7 di `docs/BALANCE-KV-ARCHITECTURE.md`
(urutan RLS, USAGE schema private, PostgREST public-only, masked secrets list).
