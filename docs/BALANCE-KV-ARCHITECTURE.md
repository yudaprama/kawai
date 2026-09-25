# Balance & KV Architecture — Worker ⇄ D1

**Tanggal:** 2026-09-24 (rev 3 — ledger token di D1, rute QRIS top-up)
**Status:** ✅ Kod live & terverifikasi (lihat §6); rute **berbayar** menunggu
pengisian konstanta `QRIS_PAYLOAD` di worker (sampai itu preview balik 503 dan
UI menampilkan notice "QRIS belum dikonfigurasi").
**Worker:** `https://kawai-worker.akuntestinguntukseto.workers.dev` (source:
`kawai-server/worker/`, TypeScript + Hono di Cloudflare Workers, binding D1
`DB` = database `kawai-auth` — satu database untuk identitas **dan** uang).

Dokumen ini menjelaskan arsitektur saldo/token yang berjalan sekarang:
**Cloudflare Worker + D1**, tanpa cache — setiap data hidup di satu tempat.

**Model rilis:** saldo = **token** (1:1 dengan pemakaian token di provider LLM, tanpa
konversi USDT). Debit usage-based dari `RemoteUsage` nyata (Fase 0b), top-up
lewat **QRIS statis** (klaim nominal unik, verifikasi admin) atau koreksi admin
via CLI.

---

## 1. Keputusan arsitektur

### 1.1 Partisi data — TIDAK ADA CACHE

| Data | Source of truth | Alasan |
|---|---|---|
| **Saldo, ledger token, klaim QRIS** | 🔒 D1 (`kawai-auth`, binding `DB`) | Uang — butuh ACID & atomic debit; D1 = SQLite ACID single-primary, satu database dg auth (email PK, tanpa join identitas) |
| **Identitas (auth)** | 🔒 D1 (sama) | Sudah di worker (Ed25519, email PRIMARY KEY) |
| **Settlement, Merkle, claim** (rencana) | 🔒 D1 | Transactional, agregasi SQL |
| **API key** (`apikey:`, `authz:`) | ✅ KV worker | Write-once, delete saat revoke |
| **Marketplace ephemeral** | ✅ KV worker | TTL native, expire sendiri |
| **Presence/heartbeat** (`online:{addr}`) | ✅ KV worker | TTL 120s = kebenaran; expire = offline |
| **Idempotency window** (`seen:{id}`) | ✅ KV worker | Dedup jendela pendek; ledger tetap di D1 |

Kriteria data yang boleh jadi source of truth di KV:
1. **Bukan uang** (bukan saldo/ledger/klaim)
2. **Toleran kehilangan** (re-register, bukan rugi finansial)
3. **Immutable atau self-expiring** (TTL)

### 1.2 Kenapa billing TIDAK bisa dari client

Client yang menentukan jumlah tagihan = tidak ada tagihan:
- client bisa **skip** pemanggilan debit,
- client bisa **manipulasi `amount`**,
- token membuktikan *siapa*, bukan *berapa* pemakaiannya.

Nilai tagihan hanya diketahui server yang melayani → **worker yang menagih**.
Debit dipanggil dari satu titik komposisi (`supervisor::plan_task`) sehingga
transport desktop **dan** web sama-sama terdebit; kebijakannya fail-open
(hormat-sistem — enforcement ketat butuh proxy LLM server-side, lihat §8).
Client hanya boleh: baca saldo (`GET /topup/balance`) dan penyesuaian saldo terkontrol
admin (`POST /admin/balance/credit`, hanya menambah/mengurang dengan guard
saldo ≥ 0).

### 1.3 Admin → worker endpoint: BOLEH

Koreksi saldo manual lewat `POST /admin/balance/credit` dengan Bearer admin —
identity dijamin token Ed25519 dan wajib sama dengan `ADMIN_EMAIL` (konstanta
di worker). Setiap koreksi masuk ledger append-only `admin_adjustment`.

---

## 2. Arsitektur final

```
app (user login — Bearer Ed25519 session token)
  │
  ├── Rust: logic/topup.rs (proxy tipis, dua wrapper) ─┐
  │     desktop: commands.rs (baca auth.token)         │
  │     web:     web.rs     (baca cookie kawai_session)│
  │                                                    ▼
  ├── GET  /topup/balance ────────────────→ D1 user_balances
  ├── GET  /topup/qris/preview ───────────→ konstanta QRIS_PAYLOAD + rentang (MIN/MAX_BASE, BASE_STEP, TOKENS_PER_IDR)
  ├── POST /topup/qris/claim {amount} ────→ D1 qris_topups (idempotent/email)
  ├── GET  /topup/qris/status/:txId ──────→ qris_topups (owner-scope)
  └── POST /billing/debit {amount} ───────→ UPDATE tokens = tokens - ?
                                              WHERE email = ? AND tokens >= ?
                                              (guard atomic → 409 bila kurang)

  supervisor::plan_task  → debit usage sekali per plan (amount = input+output tokens,
                           debit 1:1 dari saldo; gagal → warn + lanjut, fail-open)
  use-workbench.run()    → pre-check token ≤ 0 → blokir + buka halaman Top Up
                           (gagal baca → fail-open, submit jalan)

admin (CLI, Bearer admin = ADMIN_EMAIL)
  ├── scripts/qris.ts list              → pending claims
  ├── scripts/qris.ts confirm <tx_id>   → batch: status pending → credited
  │                                       + UPSERT saldo + ledger (ref = tx_id)
  ├── scripts/qris.ts reject <tx_id>    → pending → rejected (dana tak dikredit)
  └── scripts/topup.ts <email> <±amount>→ POST /admin/balance/credit + ledger

verifikasi bayar: TANPA webhook — admin mencocokkan mutasi bank dengan nominal
unik klaim, lalu confirm/reject (QRIS statis murni).
```

---

## 3. Komponen

### 3.1 Tabel D1 (binding `DB` — database `kawai-auth`)

| Tabel | Isi |
|---|---|
| `user_balances` | saldo token per email (`email` PRIMARY KEY, `tokens` integer ≥ 0) |
| `balance_ledger` | append-only audit: delta signed + `ref` (tx_id klaim / null) + dibuat saat setiap perubahan saldo |
| `qris_topups` | klaim top-up: `tx_id` (IDR unique-nominal), `package` (base nominal, string), `qr_payload`, `status`, waktu, row owner = email |

Lifecycles:

```
qris_topups.status : pending → crediting → credited (CAS lalu SATU batch atomik:
                            │              ledger ref=tx_id + UPSERT saldo + tutup status;
                            │              gagal non-UNIQUE → balik pending, retryable;
                            │              crash → re-drive setelah 30s / UNIQUE = idempoten)
                      pending → rejected    (reject admin)
                      pending → expired     (lazy, saat expires_at terlampaui)
user_balances.tokens: +nominal klaim (confirm, UPSERT) | ±koreksi admin | -usage (debit, guard ≥ 0)
```

Schema dibuat idempoten saat startup worker (`ensureQrisSchema`) — tidak ada
migration runner terpisah.

### 3.2 Endpoint worker (Bearer Ed25519, kecuali admin guard `ADMIN_EMAIL`)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/topup/qris/preview` | payload QR statis + rentang nominal pay-as-you-go (503 bila `QRIS_PAYLOAD` belum diisi) |
| POST | `/topup/qris/claim` | klaim nominal unik (idempotent: klaim saat masih pending → row sama) |
| GET | `/topup/qris/status/:txId` | status klaim (owner-scope; 404 untuk tx bukan miliknya) |
| GET | `/topup/balance` | saldo token pemanggil (0 bila belum pernah top-up) |
| POST | `/billing/debit` | debit usage (guard atomic → 409 `insufficient_balance`) |
| GET | `/topup/qris/pending` | daftar klaim pending (admin) |
| POST | `/topup/qris/confirm` | kredit klaim (admin, idempotent) |
| POST | `/topup/qris/reject` | tolak klaim (admin) |
| POST | `/admin/balance/credit` | koreksi saldo signed ± (admin, guard saldo ≥ 0) |

Tabel endpoint + detail pemanggilan lengkap: `kawai-server/worker/README.md`.

### 3.3 Sisi aplikasi

- **Rust** — `src-tauri/src/logic/topup.rs` (murni, reqwest, tanpa tauri/axum)
  diemban **kedua** wrapper: `commands.rs` (4 op, Bearer dari `auth.token`)
  dan `web.rs` (4 route `POST /api/<name>` di protected router, Bearer dari
  cookie `kawai_session`). Frontend tidak pernah mengirim token/user id.
- **Frontend** — `frontend/src/features/topup/` (Assets rail → Top Up):
  preview → isi nominal → klaim → QR + countdown → polling status (5s × 5
  menit, lalu 30s; terminal sembunyikan QR). Kartu saldo dipakai lagi oleh
  pre-check Fase 0a di `use-workbench.run()`.
- **KV worker** — tidak berubah: `apikey:`/`authz:`/`online:`/`seen:`/dll.
  Endpoint `/kv` + `/balance/:address` kini **wajib Bearer** dan menolak
  reserved key prefixes.

---

## 4. Secrets & konfigurasi

| Nilai | Bentuk | Catatan |
|---|---|---|
| `ED25519_SEED` | wrangler secret | makan token session (auth) |
| `PRIVATE_KEY` | wrangler secret | hot wallet `/transfer` — TERPISAH dari token app, tidak menyentuh ledger token |
| `QRIS_PAYLOAD`, `MIN_BASE`/`MAX_BASE`/`BASE_STEP`/`TOKENS_PER_IDR`, `EXPIRY_SECS`, `ADMIN_EMAIL` | konstanta di `qris.ts`/`billing.ts` | hardcode (aturan repo: nol env baru) |
| `KV` binding + D1 `DB` | `wrangler.toml` | sudah live (`kawai-auth`) |

---

## 4b. Top up — dua jalur

**Jalur user (QRIS, rute berbayar):** Assets rail → Top Up → isi nominal →
klaim → bayar **tepat sesuai nominal** lewat app bank/e-wallet → tunggu
verifikasi admin → `credited` (saldo naik). Nominal salah/klaim expired tidak
otomatis dikreditkan (reject admin / klaim baru — nominal dibebaskan).

**Jalur admin (koreksi manual):**
```bash
cd kawai
bun scripts/topup.ts <email> 1000000     # +1jt token
bun scripts/topup.ts <email> -500000     # koreksi minus (gagal bila saldo kurang)
bun scripts/qris.ts list                 # klaim pending (admin)
```
`scripts/topup.ts` memanggil `POST /admin/balance/credit` (Bearer admin dari
berkas `auth.token`, flag `--token-file`/`--url`) — tanpa env var baru.

---

## 5. Deployment runbook

```bash
cd kawai-server/worker
bun install
bun run typecheck
npx wrangler secret put ED25519_SEED    # sekali
npx wrangler secret put PRIVATE_KEY     # sekali (hot wallet /transfer)
bun run deploy                          # D1 kawai-auth sudah ada; schema idempoten
```

Detail endpoint & tabel: `kawai-server/worker/README.md`.

---

## 6. Verifikasi

| Lapis | Hasil |
|---|---|
| Rust `cargo check` (desktop / desktop+web / web-only / kawai-web / `--features full`) | ✅ nol error |
| Frontend `bun run build` (tsc -b + vite) | ✅ |
| Worker `bun run typecheck` + e2e lokal idempotency (claim 2× → 1 row; confirm 2× → saldo naik 1×; confirm tx random → 404; debit over → 409) | ⏳ dijalankan pada integrasi akhir — lihat §11 `PLAN-qris-topup.md` |
| E2E uang nyata (klaim → bayar → confirm → saldo naik 1×) | ⏳ setelah `QRIS_PAYLOAD` terisi + deploy |

---

## 7. Gotchas (jangan diulang)

1. **QRIS statis tanpa webhook** = verifikasi sepenuhnya kerja admin: konfirmasi
   wajib mencocokkan mutasi bank; jangan pernah auto-confirm dari nominal saja
   (attacker yang tahu nominal bisa "klaim" — dana asli tetap milik pembayar
   sah, tapi ledger jadi bohong).
2. **Nominal unik dibebaskan saat expired** — transfer ke QR klaim yang sudah
   expired TIDAK dikreditkan (UI memperingatkan; admin menolak dengan alasan
   ini). Nominal dipakai ulang oleh klaim berikutnya.
3. **Confirm idempotent wajib** — `status = pending` dicek di dalam batch
   atomik yang sama dengan UPSERT saldo + insert ledger; confirm kedua tidak
   boleh menaikkan saldo dua kali (dicek di e2e).
4. **Guard debit ada di SQL** (`WHERE tokens >= ?` + `changes == 0` → 409),
   bukan baca-tulis di aplikasi — dua debit paralel tak bisa meng-overdraw.
5. **KV eventually-consistent ~60s** — api key baru/revoke belum efektif
   global sesaat; `seen:` idempotency bisa race (worst case 1 duplikat lolos —
   ledger D1 yang menjaga).
6. **Fail-open adalah kebijakan, bukan bug** — pre-check dan debit usage tidak
   boleh pernah menjatuhkan goal submit/plan bila worker tak terjangkau
   (hormat-sistem; penegakan ketat = proxy LLM server-side, lihat §8).

---

## 8. Roadmap

- [ ] **Isi `QRIS_PAYLOAD` + konfirmasi rentang/rate `MIN_BASE`/`MAX_BASE`/
      `TOKENS_PER_IDR` {IDR → token}** +
      `ADMIN_EMAIL` (rute berbayar menunggu ini — `PLAN-qris-topup.md` §14).
- [ ] Gateway QRIS **dinamis** (Midtrans/Xendit/DOKU/Tripay): API key +
      webhook → verifikasi otomatis tanpa admin (fase 2).
- [ ] Rate-card per-model (saat ini 1:1 flat) — pinjam pola `metering/`
      `pricing.yaml`: input/output terpisah + cache discount + suffix `:free`.
- [ ] Idempotency key unik di `balance_ledger` (pinjam pola `metering/`:
      SHA-256 trace+span → `requestId` unique) — anti double-debit lintas retry.
- [ ] Key LLM server-issued (runtime fetch, bukan bundled di
      `kawai_constants::llm`) — menutup vektor ekstraksi key dari binary.
- [ ] Quota harian + reserve server-side (D1) — metering untuk seluruh turn
      (saat ini baru planner call yang terukur).
- [ ] Proxy LLM server-side (opsional, saat revenue justifikasi) —
      penegakan billing yang sesungguhnya; debit fail-open tetap hidup.
- [ ] Settlement/Merkle/rewards pindah ke D1 (keputusan terpisah saat dibangun).
