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
 *  Token dibaca dari `.env` (`KAWAI_ADMIN_TOKEN`, ditulis `voucher.ts login`) —
 *  tidak ada env var lain dan tidak perlu app desktop.
 */
import { readFileSync } from "node:fs";
import { readToken, WORKER_DEFAULT } from "./lib/worker-auth";

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
let token: string;
if (tokenFile !== "") {
  token = readFileSync(tokenFile, "utf8").trim();
} else {
  const fromEnv = readToken();
  if (fromEnv === null) {
    console.error(`Token admin tidak ada di .env (KAWAI_ADMIN_TOKEN).`);
    console.error(`Jalankan \`bun scripts/voucher.ts login\` dulu, atau beri --token-file <path>.`);
    process.exit(1);
  }
  token = fromEnv;
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
