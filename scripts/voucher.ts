#!/usr/bin/env bun
/** voucher.ts — CLI admin voucher: issue, list, revoke.
 *
 *  Pakai:
 *    bun scripts/voucher.ts issue --tokens <n> --count <n> [--note "..."] [--expires YYYY-MM-DD]
 *    bun scripts/voucher.ts list
 *    bun scripts/voucher.ts revoke <code>
 *    [--token-file <path>]   berkas auth.token admin (default: direktori data app)
 *    [--url <worker>]        default production worker; lokal: --url http://127.0.0.1:8787
 *
 *  Token dibaca dari berkas (pola sama dgn scripts/qris.ts) — tidak ada env var baru.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER_DEFAULT = "https://kawai-worker.akuntestinguntukseto.workers.dev";
const APP_DATA_ID = "pro.kawai.app";
// Harus sama dengan ADMIN_EMAIL di kawai-server/worker/src/qris.ts.
const ADMIN_EMAIL = "yudaprama@icloud.com";

interface VoucherItem {
  code: string;
  tokens: number;
  status: string;
  note: string | null;
  expiresAt: number | null;
  redeemedBy: string | null;
  redeemedAt: number | null;
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
const [cmd, arg1] = rest;
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

function formatDate(unix: number | null): string {
  if (unix == null) return "-";
  const d = new Date(unix * 1000);
  return d.toISOString().slice(0, 10);
}

if (cmd === "issue") {
  // Parse flags: --tokens, --count, --note, --expires
  let tokens: number | undefined;
  let count: number | undefined;
  let note: string | undefined;
  let expiresAt: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--tokens") tokens = Number(rest[++i]);
    else if (a === "--count") count = Number(rest[++i]);
    else if (a === "--note") note = rest[++i];
    else if (a === "--expires") {
      const ds = rest[++i];
      if (ds && /^\d{4}-\d{2}-\d{2}$/.test(ds)) {
        expiresAt = Math.floor(new Date(`${ds}T00:00:00Z`).getTime() / 1000);
      }
    }
  }
  if (!tokens || !count) {
    console.error("Usage: bun scripts/voucher.ts issue --tokens <n> --count <n> [--note '...'] [--expires YYYY-MM-DD]");
    process.exit(1);
  }
  const body: Record<string, unknown> = { tokens, count };
  if (note) body.note = note;
  if (expiresAt) body.expiresAt = expiresAt;
  const out = await req("/admin/voucher/issue", body);
  const codes = (out.codes as { code: string; tokens: number }[] | undefined) ?? [];
  console.log(`# ${codes.length} kode @ ${tokens} token${expiresAt ? ` | expires ${formatDate(expiresAt)}` : ""}${note ? ` | ${note}` : ""}`);
  for (const c of codes) console.log(c.code);
} else if (cmd === "list") {
  const out = await req("/admin/voucher/list");
  const items = (out.items ?? []) as VoucherItem[];
  for (const it of items) {
    console.log(
      `${it.code}\t${it.tokens}\t${it.status}\t${it.redeemedBy ?? "-"}\t${formatDate(it.expiresAt)}\t${formatDate(it.createdAt)}`
    );
  }
} else if (cmd === "revoke" && arg1) {
  const out = await req("/admin/voucher/revoke", { code: arg1 });
  console.log(JSON.stringify(out));
} else {
  console.error("Usage:");
  console.error("  bun scripts/voucher.ts issue --tokens <n> --count <n> [--note '...'] [--expires YYYY-MM-DD]");
  console.error("  bun scripts/voucher.ts list");
  console.error("  bun scripts/voucher.ts revoke <code>");
  console.error("  [--token-file <path>] [--url <worker>]");
  process.exit(1);
}
