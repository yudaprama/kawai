#!/usr/bin/env bun
/** qris.ts — CLI admin QRIS top-up: list pending, confirm, reject.
 *
 *  Pakai:
 *    bun scripts/qris.ts list
 *    bun scripts/qris.ts confirm <tx_id>
 *    bun scripts/qris.ts reject  <tx_id>
 *    [--token-file <path>]   berkas auth.token admin (default: direktori data app)
 *    [--url <worker>]        default production worker; lokal: --url http://127.0.0.1:8787
 *
 *  Token dibaca dari berkas (pola sama dgn scripts/topup.ts yang baca DATABASE_URL) —
 *  tidak ada env var baru.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER_DEFAULT = "https://kawai-worker.akuntestinguntukseto.workers.dev";
const APP_DATA_ID = "pro.kawai.app";
// Harus sama dengan ADMIN_EMAIL di kawai-server/worker/src/qris.ts.
const ADMIN_EMAIL = "yudaprama@icloud.com";

interface PendingItem {
  txId: string;
  email: string;
  idrAmount: number;
  tokens: number;
  createdAt: number;
}

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
const [cmd, txId] = rest;
if (tokenFile === "") {
  // Default: direktori data app utk ADMIN_EMAIL — mirror sanitize_userdir
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

let token: string;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch {
  console.error(`Token admin tidak terbaca: ${tokenFile}`);
  console.error(`Login dgn akun admin dulu (app) atau beri --token-file <path>.`);
  process.exit(1);
}

async function req(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

if (cmd === "list") {
  const out = await req("/topup/qris/pending");
  const items = (out.items ?? []) as PendingItem[];
  if (items.length === 0) {
    console.log("(tidak ada pending)");
    process.exit(0);
  }
  for (const it of items) {
    const when = new Date(it.createdAt * 1000).toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `${it.txId}  ${when}  ${it.email}  Rp${it.idrAmount.toLocaleString("id-ID")}  ->  ${it.tokens} token`,
    );
  }
  console.log(`\nVerifikasi mutasi bank dulu, lalu: bun scripts/qris.ts confirm <tx_id>`);
} else if ((cmd === "confirm" || cmd === "reject") && txId) {
  const out = await req(`/topup/qris/${cmd}`, { txId });
  const note = out.tokens !== undefined ? `  (saldo user: ${out.tokens})` : "";
  console.log(`${cmd} ${txId} -> ${String(out.status)}${note}`);
} else {
  console.error(
    "Pakai: bun scripts/qris.ts list | confirm <tx_id> | reject <tx_id> [--token-file <path>] [--url <worker>]",
  );
  process.exit(1);
}
