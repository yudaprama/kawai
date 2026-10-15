#!/usr/bin/env bun
/**
 * topup.ts — CLI admin: tambah / kurang saldo token top-up user.
 *
 * Pemakaian:
 *   bun scripts/topup.ts <email> <amount>   # amount integer signed: + = tambah, - = potong
 *   [--token-file <path>] berkas auth.token admin (default: direktori data app)
 *   [--url <worker>] default production worker; lokal: --url http://127.0.0.1:8787
 *
 * Contoh:
 *   bun scripts/topup.ts user@example.com 1000000   # +1jt token
 *   bun scripts/topup.ts user@example.com -500000   # koreksi -500rb (gagal bila saldo kurang)
 *
 * Token dibaca dari berkas (default direktori data app utk ADMIN_EMAIL) - tidak ada
 * env var baru; `bun scripts/voucher.ts login` menulis token itu.
 * Endpoint: POST /admin/balance/credit (Bearer admin — identity wajib ADMIN_EMAIL
 * di worker; saldo hidup di D1, bukan lagi DATABASE_URL/psql).
 */
import { readFileSync } from "node:fs";
import { ADMIN_EMAIL, authTokenPath, WORKER_DEFAULT } from "./lib/worker-auth";

const argv = process.argv.slice(2);
let tokenFile = "";
let url = WORKER_DEFAULT;
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--token-file") tokenFile = argv[++i] ?? "";
  else if (a === "--url") url = argv[++i] ?? "";
  else rest.push(a);
}
const [email, amountStr] = rest;
if (tokenFile === "") tokenFile = authTokenPath(ADMIN_EMAIL);

if (!email || !amountStr) {
  console.error(`Pemakaian:
  bun scripts/topup.ts <email> <amount>   # amount integer signed: + = tambah, - = potong
  [--token-file <path>] [--url <worker>]`);
  process.exit(1);
}
if (!email.includes("@")) {
  console.error(`Email tidak valid: ${email}`);
  process.exit(1);
}
const amount = Number(amountStr);
if (!Number.isSafeInteger(amount) || amount === 0) {
  console.error(`amount harus integer ≠ 0: ${amountStr}`);
  process.exit(1);
}

let token: string;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch {
  console.error(`Token admin tidak terbaca: ${tokenFile}`);
  console.error(`Jalankan \`bun scripts/voucher.ts login\` dulu, atau beri --token-file <path>.`);
  process.exit(1);
}

const resp = await fetch(`${url}/admin/balance/credit`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email, amount }),
});
const data = (await resp.json().catch(() => ({}))) as { email?: string; tokens?: number; error?: string };
if (!resp.ok) {
  console.error(`HTTP ${resp.status}${data.error ? ` ${data.error}` : ""}`);
  process.exit(1);
}
console.log(`${data.email ?? email}: saldo token ${data.tokens ?? "?"} (${amount > 0 ? "+" : ""}${amount})`);
