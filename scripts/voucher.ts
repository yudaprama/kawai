#!/usr/bin/env bun
/** voucher.ts — CLI admin voucher: signup, login, issue, list, revoke.
 *
 *  Pakai:
 *    bun scripts/voucher.ts signup                        (sekali saja, buat akun admin)
 *    bun scripts/voucher.ts login                         (token 7 hari → perlu login ulang)
 *    bun scripts/voucher.ts issue --tokens <n> --count <n> [--note "..."] [--expires YYYY-MM-DD]
 *    bun scripts/voucher.ts list
 *    bun scripts/voucher.ts revoke <code>
 *    [--email <addr>]      default ADMIN_EMAIL
 *    [--token-file <path>] berkas auth.token (default direktori data app)
 *    [--url <worker>]      default production worker; lokal: --url http://127.0.0.1:8787
 *
 *  Token dibaca dari berkas (pola sama dgn scripts/qris.ts) — tidak ada env var baru.
 *  `signup`/`login` mandiri: daftar/login via worker lalu tulis token ke path yang
 *  sama, jadi CLI tidak bergantung pada app desktop (lihat lib/worker-auth.ts).
 */
import { readFileSync } from "node:fs";
import { adminEmailFromEnv, adminPasswordFromEnv, authTokenPath, promptPassword, signIn, signUp, WORKER_DEFAULT } from "./lib/worker-auth";

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
let email = adminEmailFromEnv();
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--token-file") tokenFile = argv[++i] ?? "";
  else if (a === "--url") url = argv[++i] ?? "";
  else if (a === "--email") email = argv[++i] ?? email;
  else rest.push(a);
}
const [cmd, arg1] = rest;

if (cmd === "signup" || cmd === "login") {
  // Password dari KAWAI_ADMIN_PASSWORD (.env) kalau ada; selain itu prompt
  // tanpa echo — sehingga CLI jalan di terminal maupun di pipeline.
  const password = adminPasswordFromEnv() ?? (await promptPassword(`Password ${email}: `));
  try {
    const res = cmd === "signup" ? await signUp(url, email, password) : await signIn(url, email, password);
    console.log(`OK ${email} → token disimpan: ${res.path}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

if (tokenFile === "") tokenFile = authTokenPath(email);

let token: string;
try {
  token = readFileSync(tokenFile, "utf8").trim();
} catch {
  console.error(`Token admin tidak terbaca: ${tokenFile}`);
  console.error(`Jalankan \`bun scripts/voucher.ts login\` (atau signup sekali) — tidak perlu app desktop.`);
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
  console.error("  bun scripts/voucher.ts signup --email <addr>");
  console.error("  bun scripts/voucher.ts login  [--email <addr>]");
  console.error("  bun scripts/voucher.ts issue --tokens <n> --count <n> [--note '...'] [--expires YYYY-MM-DD]");
  console.error("  bun scripts/voucher.ts list");
  console.error("  bun scripts/voucher.ts revoke <code>");
  console.error("  [--token-file <path>] [--url <worker>] [--email <addr>]");
  process.exit(1);
}
