#!/usr/bin/env bun
/** apikey.ts — CLI kunci API gateway LLM kawai: list, create, revoke.
 *
 *  Pakai:
 *    bun scripts/apikey.ts list [--json]
 *    bun scripts/apikey.ts create <nama> [--json]
 *    bun scripts/apikey.ts revoke <id>
 *    [--url <worker>]        default KAWAI_WORKER_URL (.env) → production
 *    [--token-file <path>]   pakai token sesi dari file (menang atas sumber lain)
 *    [--email <addr>]        pilih direktori app-data desktop untuk token lokal
 *
 *  Sumber token (urutan): `--token-file` → bearer sesi app desktop
 *  (`<data_root>/last_session` → `<data_root>/<email>/auth.token`) →
 *  `KAWAI_ADMIN_TOKEN` (.env). Jadi kunci bisa dikelola tanpa browser dan tanpa
 *  mengetik password: cukup sign-in sekali di app desktop, atau
 *  `bun scripts/voucher.ts login`.
 *
 *  Kunci API sendiri hanya membuka `/v1/*` — CLI ini butuh token SESI.
 */
import { readFileSync } from "node:fs";
import {
  desktopToken,
  lastSessionEmail,
  loadRepoDotEnv,
  readToken,
  WORKER_DEFAULT,
} from "./lib/worker-auth";

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  tokensUsed: number;
  requests: number;
}

interface ApiKeyCreated {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  key: string;
}

const argv = process.argv.slice(2);
let tokenFile = "";
let url = "";
let email = "";
const rest: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--token-file") tokenFile = argv[++i] ?? "";
  else if (a === "--url") url = argv[++i] ?? "";
  else if (a === "--email") email = argv[++i] ?? "";
  else rest.push(a);
}
const jsonOut = rest.includes("--json");
const [cmd, arg1] = rest.filter((a) => a !== "--json");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Token sesi + asalnya (untuk pesan error yang jelas). */
function resolveToken(): { token: string; source: string } {
  if (tokenFile !== "") {
    let raw: string;
    try {
      raw = readFileSync(tokenFile, "utf8");
    } catch (e) {
      fail(`Tidak bisa membaca --token-file ${tokenFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return cleanToken(raw, tokenFile);
  }

  const target = email !== "" ? email.trim().toLowerCase() : lastSessionEmail();
  if (target !== null) {
    const fromDesktop = desktopToken(target);
    if (fromDesktop !== null) {
      return cleanToken(fromDesktop, `app desktop (${target})`);
    }
  }

  const fromEnv = readToken();
  if (fromEnv !== null) return cleanToken(fromEnv, "KAWAI_ADMIN_TOKEN (.env)");

  fail(
    [
      "Tidak ada token sesi.",
      "  · sign-in sekali di app desktop (token dibaca otomatis), atau",
      "  · `bun scripts/voucher.ts login` (menulis KAWAI_ADMIN_TOKEN ke .env), atau",
      "  · `--token-file <path>` / `--email <addr>` untuk lokasi lain.",
    ].join("\n"),
  );
}

/** Bearer harus satu baris — file yang salah (mis. skrip, bukan token) ditolak
 *  di sini, bukan sebagai TypeError dari `fetch`. */
function cleanToken(raw: string, source: string): { token: string; source: string } {
  const token = raw.trim();
  if (token.length === 0) fail(`${source} kosong.`);
  if (/\s/.test(token)) fail(`${source} bukan token sesi satu baris (JWT tanpa spasi).`);
  return { token, source };
}

loadRepoDotEnv();
// Trailing slash di URL worker akan menghasilkan `//apikeys`.
const base = (url || process.env.KAWAI_WORKER_URL?.trim() || WORKER_DEFAULT).replace(/\/+$/, "");
const { token, source } = resolveToken();

async function req(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = JSON.stringify(data);
    console.error(`HTTP ${resp.status}: ${detail}`);
    if (resp.status === 401) {
      console.error(`Token sesi (${source}) ditolak — token TTL 7 hari. Login ulang: bun scripts/voucher.ts login`);
    }
    if (resp.status === 404) {
      console.error("Route /apikeys belum ada di worker ini — deploy worker versi terbaru (bun run deploy).");
    }
    process.exit(1);
  }
  return data;
}

/** `YYYY-MM-DD HH:MM` UTC — waktu ledger worker. */
function stamp(unix: number | null): string {
  if (unix == null) return "-";
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}

if (cmd === "list") {
  const out = (await req("/apikeys", "GET")) as { keys?: ApiKeyView[] };
  const keys = out.keys ?? [];
  if (jsonOut) {
    console.log(JSON.stringify(keys, null, 2));
  } else if (keys.length === 0) {
    console.log("Belum ada kunci. Buat: bun scripts/apikey.ts create <nama>");
  } else {
    const rows = [
      ["ID", "PREFIX", "NAMA", "DIBUAT", "TERAKHIR", "STATUS", "TOKEN", "REQ"],
      ...keys.map((k) => [
        k.id,
        k.prefix,
        k.name,
        stamp(k.createdAt),
        stamp(k.lastUsedAt),
        k.revokedAt ? "revoked" : "aktif",
        String(k.tokensUsed),
        String(k.requests),
      ]),
    ];
    for (const row of rows) console.log(row.join("\t"));
  }
} else if (cmd === "create") {
  const name = (arg1 ?? "").trim();
  const created = (await req("/apikeys", "POST", name ? { name } : {})) as ApiKeyCreated;
  if (jsonOut) {
    console.log(JSON.stringify(created, null, 2));
  } else {
    console.log(`kunci baru   : ${created.key}`);
    console.log(`id           : ${created.id}`);
    console.log(`prefix       : ${created.prefix}`);
    console.log(`nama         : ${created.name}`);
    console.log("");
    console.log("Simpan sekarang — plaintext tidak bisa ditampilkan lagi. Cabut: apikey.ts revoke <id>");
    console.log(`  OpenAI-compatible : baseURL ${base}/v1  +  apiKey <kunci>`);
    console.log(`  Claude Code       : ANTHROPIC_BASE_URL=${base}/anthropic  +  ANTHROPIC_AUTH_TOKEN=<kunci>`);
  }
} else if (cmd === "revoke" && arg1) {
  const out = await req(`/apikeys/${encodeURIComponent(arg1)}/revoke`, "POST");
  console.log(jsonOut ? JSON.stringify(out, null, 2) : `dicabut: ${arg1}`);
} else {
  console.error("Usage:");
  console.error("  bun scripts/apikey.ts list [--json]");
  console.error("  bun scripts/apikey.ts create [nama] [--json]");
  console.error("  bun scripts/apikey.ts revoke <id>");
  console.error("  [--url <worker>] [--token-file <path>] [--email <addr>]");
  process.exit(1);
}
