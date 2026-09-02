-- ============================================================================
-- Balance & ledger system — pengganti modul balance `x/store` di Supabase
--
-- Prinsip keamanan:
--   - Semua tabel ada di schema `private` yang TIDAK terekspos Data API.
--     Token user (anon/authenticated) tidak punya jalur akses langsung ke
--     tabel — user TIDAK BISA membaca/mengubah saldo sendiri via REST.
--   - Satu-satunya pintu untuk user: RPC SECURITY DEFINER yang memverifikasi
--     auth.uid() di dalam body, dan EXECUTE-nya di-REVOKE dari anon.
--   - Debit sistemik (billing per token usage dari worker) lewat Edge
--     Function dengan service_role, yang diwajibkan mengirim p_user_id.
--   - Satuan: micro-USDT (bigint) — sama dengan konvensi x/store.
-- ============================================================================

create schema if not exists private;

-- tidak ada grant default untuk anon/authenticated pada schema private;
-- eksplisitkan REVOKE untuk kejelasan. service_role TETAP butuh USAGE agar
-- Edge Function (PostgREST dgn service key) bisa memanggil RPC di sini:
revoke all on schema private from anon, authenticated;
grant usage on schema private to service_role;

-- ----------------------------------------------------------------------------
-- Saldo user (mirror x/store UserBalance)
-- ----------------------------------------------------------------------------
create table if not exists private.user_balances (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  usdt_balance  bigint not null default 0 check (usdt_balance >= 0),
  kawai_balance numeric not null default 0 check (kawai_balance >= 0),
  trial_claimed boolean not null default false,
  updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Ledger append-only: setiap perubahan saldo tercatat (audit + reconciliation)
-- ----------------------------------------------------------------------------
create table if not exists private.balance_ledger (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  delta       bigint not null,              -- + credit / - debit (micro-USDT)
  balance_after bigint not null,
  reason      text not null,                -- 'usage', 'deposit', 'trial', 'manual', ...
  ref         jsonb,                        -- konteks bebas (tx hash, job id, dst)
  created_at  timestamptz not null default now()
);
create index if not exists balance_ledger_user_idx on private.balance_ledger (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Debt: gagal debit setelah layanan terpakai (mirror x/store RecordDebt)
-- ----------------------------------------------------------------------------
create table if not exists private.balance_debts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  amount      bigint not null,
  reason      text not null,
  settled     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists balance_debts_unsettled_idx on private.balance_debts (user_id) where not settled;

-- tetap RLS on sebagai defense in depth (service_role bypass by design)
alter table private.user_balances enable row level security;
alter table private.balance_ledger enable row level security;
alter table private.balance_debts enable row level security;
revoke all on all tables in schema private from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Helper: pastikan row saldo ada (dipanggil di dalam SECURITY DEFINER)
-- ----------------------------------------------------------------------------
create or replace function private.ensure_balance_row(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.user_balances (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: user membaca saldo sendiri (satu-satunya jalur read utk user)
-- ----------------------------------------------------------------------------
create or replace function private.get_my_balance()
returns private.user_balances
language sql
security definer
set search_path = ''
stable
as $$
  select * from private.user_balances where user_id = auth.uid();
$$;

-- ----------------------------------------------------------------------------
-- RPC: user top-up/send counterparty (credit terkontrol, hanya menambah)
-- catatan: deposit on-chain yang terverifikasi tetap lewat service_role;
-- RPC ini untuk kasus seperti klaim trial.
-- ----------------------------------------------------------------------------
create or replace function private.credit_my_balance(p_amount bigint, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_new  bigint;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  -- whitelist alasan yang boleh dipicu user
  if p_reason not in ('trial', 'deposit_claim') then
    raise exception 'reason not allowed: %', p_reason;
  end if;

  perform private.ensure_balance_row(v_user);

  update private.user_balances
     set usdt_balance = usdt_balance + p_amount,
         trial_claimed = trial_claimed or (p_reason = 'trial'),
         updated_at = now()
   where user_id = v_user
   returning usdt_balance into v_new;

  insert into private.balance_ledger (user_id, delta, balance_after, reason)
  values (v_user, p_amount, v_new, p_reason);

  return v_new;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: DEBIT ATOMIC — inti pengganti DeductBalanceAtomic x/store.
--   Tiga pemanggil sah:
--   1. service_role (Edge Function billing, worker) — p_user_id wajib,
--   2. user utk dirinya sendiri — p_user_id null → auth.uid()
--      (grant-nya tidak ada di REST; hanya via EF kalau suatu saat perlu),
--   3. ADMIN (JWT dgn app_metadata.role='admin') — p_reason wajib 'manual'
--      dan p_admin_id wajib (untuk audit ledger).
--   - atomic: WHERE saldo cukup, tanpa race (row lock by UPDATE).
--   - gagal → raise exception 'insufficient balance' (HTTP 409 di EF).
-- ----------------------------------------------------------------------------
create or replace function private.debit_balance(
  p_user_id  uuid,
  p_amount   bigint,
  p_reason   text,
  p_admin_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := coalesce(p_user_id, auth.uid());
  v_is_admin boolean := (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin';
  v_new      bigint;
begin
  if v_user is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;

  if auth.uid() is null then
    -- tanpa JWT user: hanya service_role (path billing worker)
    if auth.role() is distinct from 'service_role' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif auth.uid() is distinct from v_user and not v_is_admin then
    -- JWT user biasa hanya boleh dirinya sendiri
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- path admin: wajib manual + identitas admin utk audit
  if v_is_admin then
    if p_reason is distinct from 'manual' or p_admin_id is null then
      raise exception 'admin debit requires reason=manual and admin_id';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  perform private.ensure_balance_row(v_user);

  update private.user_balances
     set usdt_balance = usdt_balance - p_amount,
         updated_at = now()
   where user_id = v_user
     and usdt_balance >= p_amount          -- ← atomic guard, tanpa race
   returning usdt_balance into v_new;

  if v_new is null then
    raise exception 'insufficient balance' using errcode = 'P0001';
  end if;

  insert into private.balance_ledger (user_id, delta, balance_after, reason, ref)
  values (
    v_user, -p_amount, v_new, p_reason,
    case when p_admin_id is not null
      then jsonb_build_object('admin_id', p_admin_id)
    end
  );

  return v_new;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: catat debt (hanya service_role — dari Edge Function saat debit gagal)
-- ----------------------------------------------------------------------------
create or replace function private.record_debt(p_user_id uuid, p_amount bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into private.balance_debts (user_id, amount, reason)
  values (p_user_id, p_amount, p_reason);
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants: RPC read/write user
-- ----------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon;
grant execute on function private.get_my_balance() to authenticated;
grant execute on function private.credit_my_balance(bigint, text) to authenticated;
-- debit & record_debt: service_role (billing worker) + authenticated
-- (admin manual — otorisasi role='admin' dicek DI DALAM RPC body, bukan
-- di grant; user non-admin dipaksa 'forbidden' oleh guard di dalam RPC):
grant execute on function private.debit_balance(uuid, bigint, text, uuid) to service_role, authenticated;
grant execute on function private.record_debt(uuid, bigint, text) to service_role;

-- ----------------------------------------------------------------------------
-- Policies (defense in depth; schema private memang tak terekspos)
-- ----------------------------------------------------------------------------
create policy "no direct access" on private.user_balances for select
  to authenticated using (false);
create policy "no direct access" on private.balance_ledger for select
  to authenticated using (false);
