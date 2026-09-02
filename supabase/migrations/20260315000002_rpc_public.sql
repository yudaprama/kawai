-- ============================================================================
-- Follow-up: RPC dipindah dari schema `private` ke `public`.
--
-- Alasan: PostgREST/Data API hanya mengekspos schema `public`, jadi EF tidak
-- bisa memanggil /rpc/* di `private`. Tabel TETAP di `private` (tidak terekspos
-- ke client). Akses RPC dikontrol via EXECUTE grant + guard di dalam body:
--   - anon: TANPA execute (revoke dari public yang di-grant otomatis Postgres)
--   - authenticated: get_my_balance, credit_my_balance (whitelist reason),
--     debit_balance (guard role='admin' di body utk debit pihak lain)
--   - service_role: semuanya (path Edge Function)
-- ============================================================================

create or replace function public.debit_balance(
  p_user_id uuid, p_amount bigint, p_reason text, p_admin_id uuid default null
) returns bigint language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := coalesce(p_user_id, auth.uid());
  v_is_admin boolean := (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin';
  v_new bigint;
begin
  if v_user is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if auth.uid() is null then
    if auth.role() is distinct from 'service_role' then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif auth.uid() is distinct from v_user and not v_is_admin then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_is_admin and (p_reason is distinct from 'manual' or p_admin_id is null) then
    raise exception 'admin debit requires reason=manual and admin_id';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  perform private.ensure_balance_row(v_user);
  update private.user_balances set usdt_balance = usdt_balance - p_amount, updated_at = now()
   where user_id = v_user and usdt_balance >= p_amount
   returning usdt_balance into v_new;
  if v_new is null then raise exception 'insufficient balance' using errcode = 'P0001'; end if;
  insert into private.balance_ledger (user_id, delta, balance_after, reason, ref)
  values (v_user, -p_amount, v_new, p_reason,
    case when p_admin_id is not null then jsonb_build_object('admin_id', p_admin_id) end);
  return v_new;
end $$;

create or replace function public.get_my_balance() returns private.user_balances
language sql security definer set search_path = '' stable
as $$ select * from private.user_balances where user_id = auth.uid(); $$;

create or replace function public.credit_my_balance(p_amount bigint, p_reason text) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_new bigint;
begin
  if v_user is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if p_reason not in ('trial','deposit_claim') then raise exception 'reason not allowed: %', p_reason; end if;
  perform private.ensure_balance_row(v_user);
  update private.user_balances
     set usdt_balance = usdt_balance + p_amount,
         trial_claimed = trial_claimed or (p_reason = 'trial'),
         updated_at = now()
   where user_id = v_user returning usdt_balance into v_new;
  insert into private.balance_ledger (user_id, delta, balance_after, reason)
  values (v_user, p_amount, v_new, p_reason);
  return v_new;
end $$;

create or replace function public.record_debt(p_user_id uuid, p_amount bigint, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into private.balance_debts (user_id, amount, reason) values (p_user_id, p_amount, p_reason);
end $$;

-- Postgres memberi EXECUTE ke PUBLIC secara default → cabut, lalu grant eksplisit
revoke all on function public.debit_balance(uuid,bigint,text,uuid) from public, anon;
revoke all on function public.get_my_balance() from public, anon;
revoke all on function public.credit_my_balance(bigint,text) from public, anon;
revoke all on function public.record_debt(uuid,bigint,text) from public, anon, authenticated;
grant execute on function public.get_my_balance() to authenticated;
grant execute on function public.credit_my_balance(bigint,text) to authenticated;
grant execute on function public.debit_balance(uuid,bigint,text,uuid) to service_role, authenticated;
grant execute on function public.record_debt(uuid,bigint,text) to service_role;

-- Duplikat di schema private sudah tidak dipakai (tidak reachable via REST);
-- dibiarkan tanpa execute grant sebagai dead code, atau drop manual:
-- drop function if exists private.get_my_balance();
-- drop function if exists private.credit_my_balance(bigint,text);
-- drop function if exists private.debit_balance(uuid,bigint,text,uuid);
-- drop function if exists private.record_debt(uuid,bigint,text);
