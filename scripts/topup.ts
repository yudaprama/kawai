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
 * Token dibaca dari berkas (pola sama scripts/qris.ts) - tidak ada env var baru.
 * Endpoint: POST /admin/balance/credit (Bearer admin — identity wajib ADMIN_EMAIL
 * di worker; saldo hidup di D1, bukan lagi DATABASE_URL/psql).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER_DEFAULT = "https://kawai-worker.akuntestinguntukseto.workers.dev";
const APP_DATA_ID = "pro.kawai.app";
// Harus sama dengan ADMIN_EMAIL di kawai-server/worker/src/billing.ts.
const ADMIN_EMAIL = "yudaprama@icloud.com";

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
if (tokenFile === "") {
  // Default: direktori data app utk ADMIN_EMAIL - mirror sanitize_userdir
  // (id mengandung @/. di-hex agar valid nama folder).
  tokenFile = join(
    homedir(),
    "Library",
    "Application Support",
    APP_DATA_ID,
    /^[A-Za-z0-9_-]+$/.test(ADMIN_EMAIL) ? ADMIN_EMAIL : Buffer.from(ADMIN_EMAIL, "utf8").toString("hex"),
    "auth.token",
  );
}

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
  console.error(`Login dgn akun admin dulu (app) atau beri --token-file <path>.`);
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
