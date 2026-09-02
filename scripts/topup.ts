#!/usr/bin/env bun
/**
 * topup.ts — CLI top up token credit (release interim, admin manual).
 *
 * Pemakaian:
 *   bun scripts/topup.ts <email|uuid> <amount>       # tambah credit (+/-)
 *   bun scripts/topup.ts list [query]                # cari user + saldo
 *
 * Contoh:
 *   bun scripts/topup.ts user@example.com 1000000    # +1jt token credit
 *   bun scripts/topup.ts 11111111-...-111 500000
 *   bun scripts/topup.ts list alice
 *
 * Sumber koneksi: DATABASE_URL di kawai/.env (jangan commit kredensial).
 */

import { $ } from "bun";

const ENV_FILE = new URL("../.env", import.meta.url);

async function databaseUrl(): Promise<string> {
  const text = await Bun.file(ENV_FILE).text();
  const line = text.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) {
    console.error("DATABASE_URL tidak ditemukan di kawai/.env");
    process.exit(1);
  }
  return line.slice("DATABASE_URL=".length).trim();
}

async function psql(sql: string): Promise<string> {
  const url = await databaseUrl();
  const proc = Bun.spawn(["psql", url, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`psql error:\n${err}`);
    process.exit(code);
  }
  return out.trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveUser(q: string): Promise<{ id: string; email: string; balance: string }> {
  let row: string;
  if (UUID_RE.test(q)) {
    row = await psql(`
      select u.id || '|' || coalesce(u.email,'?') || '|' ||
             coalesce(b.usdt_balance::text,'0')
      from auth.users u
      left join private.user_balances b on b.user_id = u.id
      where u.id = '${q}'`);
  } else {
    row = await psql(`
      select u.id || '|' || coalesce(u.email,'?') || '|' ||
             coalesce(b.usdt_balance::text,'0')
      from auth.users u
      left join private.user_balances b on b.user_id = u.id
      where u.email = '${q.replaceAll("'", "''")}'`);
  }
  if (!row) {
    console.error(`User tidak ditemukan: ${q}`);
    process.exit(1);
  }
  const [id, email, balance] = row.split("|");
  return { id, email, balance };
}

const args = process.argv.slice(2);
const [cmd, arg2, arg3] = args;

if (cmd === "list") {
  const target = arg2;
  const filter = target ? `where u.email ilike '%${target.replaceAll("'", "''")}%'` : "";
  const rows = await psql(`
    select rpad(coalesce(u.email,'?'), 34) || format('%12s', coalesce(b.usdt_balance::text,'0'))
    from auth.users u
    left join private.user_balances b on b.user_id = u.id
    ${filter}
    order by u.email limit 30`);
  console.log(rows || "(tidak ada user)");
  process.exit(0);
}

if (cmd && arg2) {
  const amount = Number(arg2);
  if (!Number.isSafeInteger(amount) || amount === 0) {
    console.error("amount harus integer non-zero (token credit)");
    process.exit(1);
  }
  const user = await resolveUser(cmd);
  console.log(`user    : ${user.email} (${user.id})`);
  console.log(`saldo   : ${user.balance} token credit`);
  console.log(`top up  : ${amount > 0 ? "+" : ""}${amount}`);

  await psql(`select private.ensure_balance_row('${user.id}');`);
  await psql(`
    begin;
    update private.user_balances
       set usdt_balance = usdt_balance + ${amount}, updated_at = now()
     where user_id = '${user.id}';
    insert into private.balance_ledger (user_id, delta, balance_after, reason, ref)
    select '${user.id}'::uuid, ${amount}, usdt_balance, 'manual',
           jsonb_build_object('via', 'topup-cli')
      from private.user_balances where user_id = '${user.id}';
    commit;`);

  const after = await resolveUser(user.id);
  console.log(`saldo   : ${after.balance} token credit ✅`);
  process.exit(0);
}

console.error(`Pemakaian:
  bun scripts/topup.ts <email|uuid> <amount>   # top up (+/-) token credit
  bun scripts/topup.ts list [query]            # daftar user + saldo`);
process.exit(1);
