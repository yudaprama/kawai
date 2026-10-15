/** worker-auth.ts — kredensial + sesi worker untuk CLI admin.
 *
 *  CLI admin (`scripts/voucher.ts`, `qris.ts`, `topup.ts`) sebelumnya hanya
 *  membaca `auth.token` yang dibuat app desktop — shell murni tidak pernah bisa
 *  menerbitkan voucher, dan tidak ada mirror JS dari `kawai_vault::encode_string`
 *  (derivasi kredensial hanya ada di Rust, `local_auth.rs` `derive_credential`).
 *  Modul ini menutup gap itu:
 *
 *    signup → POST /auth/sign_up {email, salt, credential} → {token}
 *    login  → POST /auth/sign_in {email, credential}        → {token}
 *
 *  Semua secret CLI (email, password, token) tinggal di `.env` repo root:
 *  `KAWAI_ADMIN_EMAIL`, `KAWAI_ADMIN_PASSWORD`, `KAWAI_ADMIN_TOKEN` (token TTL
 *  7 hari → `login` menyegarnya). `issue`/`list`/`revoke` membaca token dari
 *  sana — tanpa state di luar repo dan tanpa app desktop.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Harus sama dengan `ADMIN_EMAIL` di `kawai-server/worker/src/qris.ts` —
 *  guard admin worker menolak identity lain dengan 403. */
export const ADMIN_EMAIL = "yudaprama@icloud.com";

export const WORKER_DEFAULT = "https://kawai-worker.akuntestinguntukseto.workers.dev";
export const APP_DATA_ID = "pro.kawai.app";

/** Sanitize email → nama folder app-data (identik `sanitize_userdir` Rust). */
export function userDirName(email: string): string {
	return /^[A-Za-z0-9_-]+$/.test(email) ? email : Buffer.from(email, "utf8").toString("hex");
}

export function userDataDir(email: string): string {
	return join(homedir(), "Library", "Application Support", APP_DATA_ID, userDirName(email));
}

/** Path `auth.token` untuk sebuah email (default CLI = email admin). */
export function authTokenPath(email: string): string {
	return join(userDataDir(email), "auth.token");
}

// ─── kawai_vault::encode_string (port deterministik) ───────────────────────
// Fungsi murni: seed tetap, hanya bergantung pada panjang input. Tidak ada RNG,
// jam, atau state global — jadi port ini byte-for-byte sama dengan Rust.

function generateLengthKey(length: number): number[] {
	const keyLen = (length % 16) + 8;
	const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53];
	const key: number[] = [];
	for (let i = 0; i < keyLen; i++) {
		let val = (length * primes[i % primes.length]!) ^ (length >>> (i % 8));
		val = val ^ (i * 31 + length * 17);
		key.push(val & 0xff);
	}
	return key;
}

function generateMixTable(): number[] {
	const table = Array.from({ length: 256 }, (_, i) => i);
	const mask = (1n << 64n) - 1n;
	let seed = 0x123456789abcdef0n;
	for (let i = 255; i >= 1; i--) {
		seed = (seed * 6364136223846793005n + 1442695040888963407n) & mask;
		const j = Number((seed >> 32n) % BigInt(i + 1));
		const tmp = table[i]!;
		table[i] = table[j]!;
		table[j] = tmp;
	}
	return table;
}

function getPositionPattern(pos: number, length: number): number {
	return (((pos * 31) ^ (length * 17)) ^ ((pos * length) % 256)) & 0xff;
}

/** Bit permutation 76543210 → 24601357 (Rust `shuffle_bits` forward). */
function shuffleBits(data: number[]): number[] {
	return data.map(
		(b) =>
			((b & 0x80) >> 5) |
			((b & 0x40) >> 2) |
			((b & 0x20) << 1) |
			((b & 0x10) >> 4) |
			((b & 0x08) >> 2) |
			((b & 0x04) << 1) |
			((b & 0x02) << 4) |
			((b & 0x01) << 7)
	);
}

/** Permutasi blok 8 dengan `perm = [0,5,2,7,4,1,6,3]` (Rust `transpose_blocks` forward). */
function transposeBlocks(data: number[]): number[] {
	const length = data.length;
	if (length < 2) return data.slice();
	const perm = [0, 5, 2, 7, 4, 1, 6, 3];
	const result = new Array<number>(length).fill(0);
	for (let i = 0; i < length; i++) {
		const blockIdx = Math.floor(i / 8);
		let newPos = blockIdx * 8 + perm[i % 8]!;
		if (newPos >= length) newPos = i;
		result[newPos] = data[i]!;
	}
	return result;
}

/** Rotasi karakter base64 per posisi `(i*7)%64` (Rust `rotate_base64` forward). */
function rotateBase64(input: string): string {
	let result = "";
	let i = 0;
	for (const ch of input) {
		const rotation = (i * 7) % 64;
		i++;
		let out = ch;
		if (ch >= "A" && ch <= "Z") {
			out = String.fromCharCode(65 + (((ch.charCodeAt(0) - 65 + rotation) % 26) + 26) % 26);
		} else if (ch >= "a" && ch <= "z") {
			out = String.fromCharCode(97 + (((ch.charCodeAt(0) - 97 + rotation) % 26) + 26) % 26);
		} else if (ch >= "0" && ch <= "9") {
			out = String.fromCharCode(48 + (((ch.charCodeAt(0) - 48 + rotation) % 10) + 10) % 10);
		}
		result += out;
	}
	return result;
}

/** Port persis `kawai_vault::encode_string`. */
export function encodeString(input: string): string {
	if (input.length === 0) return "";
	const mixTable = generateMixTable();
	let data: Uint8Array = Uint8Array.from(Buffer.from(input, "utf8"));
	const length = data.length;

	const lengthKey = generateLengthKey(length);
	for (let i = 0; i < length; i++) data[i] = data[i]! ^ lengthKey[i % lengthKey.length]!;
	for (let i = 0; i < length; i++) data[i] = mixTable[data[i]!]!;

	const shuffled: number[] = [];
	for (let i = 0; i < length; i++) shuffled.push(data[i]!);
	const transposed = transposeBlocks(shuffleBits(shuffled));
	for (let i = 0; i < length; i++) data[i] = transposed[i]! ^ getPositionPattern(i, length);

	return rotateBase64(Buffer.from(data).toString("base64"));
}

/** `credential` yang dikirim worker — mirror `derive_credential` Rust
 *  (`sha256(salt_hex || encode_string(password))`). */
export function deriveCredential(saltHex: string, password: string): string {
	return createHash("sha256").update(saltHex, "utf8").update(encodeString(password), "utf8").digest("hex");
}

export function randomSalt(): string {
	return randomBytes(16).toString("hex");
}

// ─── Penyimpanan token (`.env` repo root — satu-satunya tempat) ────────────
// `KAWAI_ADMIN_TOKEN` ditulis di `.env` (gitignored) bersama email+password,
// jadi semua secret admin worker berada di satu file. Tidak ada token di
// app-data: `auth.token` milik app desktop, bukan CLI.

const TOKEN_KEY = "KAWAI_ADMIN_TOKEN";

export function readToken(): string | null {
	loadRepoDotEnv();
	const token = process.env[TOKEN_KEY]?.trim();
	return token !== undefined && token.length > 0 ? token : null;
}

/** Tulis/segarkan `KAWAI_ADMIN_TOKEN` di `.env` (mengganti nilai lama). */
export function writeToken(token: string): string {
	const path = REPO_DOT_ENV;
	let lines: string[];
	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		lines = [];
	}
	const entry = `${TOKEN_KEY}=${token}`;
	const at = lines.findIndex((l) => l.trimStart().startsWith(`${TOKEN_KEY}=`));
	if (at >= 0) lines[at] = entry;
	else lines.push(entry);
	const text = `${lines.join("\n").replace(/\n+$/, "")}\n`;
	writeFileSync(path, text, { mode: 0o600 });
	return path;
}

// ─── Worker calls ─────────────────────────────────────────────────────────

interface JsonObject {
	[key: string]: unknown;
}

/** Ambil field string dari JSON worker; `undefined` bila absen/non-string. */
function jsonString(body: unknown, key: string): string | undefined {
	if (typeof body !== "object" || body === null || !(key in body)) return undefined;
	const value = (body as JsonObject)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function post(
	url: string,
	path: string,
	body: JsonObject
): Promise<{ status: number; data: unknown }> {
	const resp = await fetch(`${url}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: resp.status, data: await resp.json().catch(() => ({})) };
}

export interface AuthResult {
	token: string;
	path: string;
}

/** Daftarkan email+password baru; worker membalas token langsung. */
export async function signUp(url: string, email: string, password: string): Promise<AuthResult> {
	const salt = randomSalt();
	const { status, data } = await post(url, "/auth/sign_up", {
		email,
		salt,
		credential: deriveCredential(salt, password),
	});
	const token = jsonString(data, "token");
	if (status !== 200 || token === undefined) {
		throw new Error(`sign_up gagal (HTTP ${status}): ${JSON.stringify(data)}`);
	}
	return { token, path: writeToken(token) };
}

/** Login akun yang sudah terdaftar → token baru. */
export async function signIn(url: string, email: string, password: string): Promise<AuthResult> {
	const saltRes = await post(url, "/auth/salt", { email });
	const salt = jsonString(saltRes.data, "salt");
	if (salt === undefined) {
		throw new Error(`salt gagal untuk ${email}: ${JSON.stringify(saltRes.data)}`);
	}
	const { status, data } = await post(url, "/auth/sign_in", {
		email,
		credential: deriveCredential(salt, password),
	});
	const token = jsonString(data, "token");
	if (status !== 200 || token === undefined) {
		throw new Error(`sign_in gagal (HTTP ${status}): ${JSON.stringify(data)}`);
	}
	return { token, path: writeToken(token) };
}


// ─── Kredensial dari .env (opsional) ──────────────────────────────────────
// CLI script tidak baca `.env` (dipanggil langsung, bukan lewat app yang
// memanggil `dotenvy`), jadi `KAWAI_ADMIN_EMAIL` / `KAWAI_ADMIN_PASSWORD`
// di repo root dimuat manual. Semantik sama dengan dotenvy: variabel yang
// sudah ada di environment TIDAK ditimpa.

const REPO_DOT_ENV = join(import.meta.dir, "..", "..", ".env");

export function loadRepoDotEnv(path: string = REPO_DOT_ENV): void {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return; // .env opsional — CLI tetap jalan dengan prompt/env.
	}
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq).trim();
		if (key.startsWith("export ") || key in process.env) continue;
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

/** Email admin dari `.env` (`KAWAI_ADMIN_EMAIL`), default konstanta worker. */
export function adminEmailFromEnv(): string {
	loadRepoDotEnv();
	const fromEnv = process.env.KAWAI_ADMIN_EMAIL?.trim();
	return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : ADMIN_EMAIL;
}

/** Password admin dari `.env`, atau `undefined` → CLI harus prompt. */
export function adminPasswordFromEnv(): string | undefined {
	loadRepoDotEnv();
	const fromEnv = process.env.KAWAI_ADMIN_PASSWORD;
	return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Prompt password tanpa echo (raw mode; Enter selesai, Ctrl-C batal). */
export function promptPassword(prompt: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin;
	const output = process.stdout;
	let buffer = "";

	const cleanup = (): void => {
		input.removeListener("data", onData);
		if (input.isTTY) input.setRawMode(false);
		input.pause();
		output.write("\n");
	};

	function onData(chunk: Buffer): void {
		for (const ch of chunk.toString("utf8")) {
			if (ch === "\n" || ch === "\r") {
				cleanup();
				resolve(buffer);
				return;
			}
			if (ch === String.fromCharCode(3)) {
				cleanup();
				reject(new Error("dibatalkan"));
				return;
			}
			if (ch === String.fromCharCode(127) || ch === "\b") {
				buffer = buffer.slice(0, -1);
				continue;
			}
			buffer += ch;
			output.write("*");
		}
	}

	if (input.isTTY) input.setRawMode(true);
	input.resume();
	input.on("data", onData);
	output.write(prompt);
	return promise;
}