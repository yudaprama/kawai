# Supervisor UI/UX

Rencana permukaan UI untuk mekanisme supervisor (arsitektur & current state:
**PLAN-supervisor.md**). Prinsip pembatas: **plan
adalah artifact utama, chat adalah narasi** — `use-supervisor-plan.ts` sudah
memegang kontrak ini (steps tidak diproyeksikan ke chat tool parts;
percakapan hanya membawa goal + final output). Semua item di sini mengeksploitasi
semantik backend yang sudah ada (plan tervalidasi, wave deterministik,
memo/resume, replan, confirmation gate, cancellation kooperatif), bukan fitur
baru di backend.

Mode desain: **Operate** — user menitipkan pekerjaan ke mesin deterministik.
Yang dibutuhkan: scanability, kontrol, kepastian status. Ekspresi visual
bukan prioritas permukaan ini.

## Prioritas

Urutan eksekusi: R1 + R2 (kejujuran kontrol, risiko rendah) → R3 (nilai
produk terbesar) → R4 + R5 (satu pass, menyentuh render step yang sama) →
R6 + R7 → P2. Kebutuhan backend dicantumkan per item; mayoritas frontend-only.

---

## R1 — Plan review sebelum eksekusi (P0, frontend-only)

**Gap terbesar.** Sekarang `plan_task` → plan tervalidasi → langsung
`execute_supervisor_plan`. Backend sengaja memisah dua operasi ini — gerbang
review bisa dibangun hampir murni di frontend:

```
goal → plan_task → [REVIEW: tampilkan plan, user bisa
                    ▸ jalankan / ▸ hapus step / ▸ ubah urutan] → execute
```

Ini satu-satunya momen di mana output LLM masih bisa dikoreksi murah, dan
determinisme supervisor membuat janji review *dapat dipercaya*: yang disetujui
adalah yang dijalankan.

**Render di review:**

- Tiap step: tool, task, `dependsOn`, struktur wave yang dihitung dari
  `dependsOn`.
- Step dengan `requiresConfirmation: true` (registry-owned) ditandai
  "akan minta konfirmasi saat eksekusi".
- Step non-dispatchable (sudah difilter `NON_DISPATCHABLE_TOOLS` di
  `supervisor.rs`) tidak muncul — atau ditandai bila planner mengusilkannya.
- `PlanStarted` berubah peran: dari "info" menjadi "kontrak yang dijalankan".

**Backend:** tidak ada. `plan_task` sudah mengembalikan plan tervalidasi;
eksekusi tetap operasi terpisah.

## R2 — Kartu konfirmasi layak untuk `awaitingConfirmation` (P0)

Confirmation gate adalah momen paling sensitif di produk (side-effect).
`PendingConfirmations` + `respond_supervisor_confirmation` sudah solid;
permukaannya yang harus naik kelas:

- Kartu modal/inline yang menghentikan scroll: tool mana, task apa, deskripsi
  konfirmasi (sudah dikirim di `ConfirmationRequested`), progres sejauh ini
  ("3 langkah selesai — langkah ke-4 menunggu persetujuan Anda").
- Label tombol dari konteks ("Jalankan data_import"), bukan OK/Cancel generik.
- State "menunggu jawaban Anda" harus tampil bila stream terputus — backend
  menganggapnya `ConfirmationRequired` (gagal); UI tidak boleh diam.

**Backend:** tidak ada.

## R3 — Stop jujur soal cancellation kooperatif (P0)

Cancellation berhenti di batas wave; tool aktif menyelesaikan diri dulu.
User yang menekan Stop lalu melihat step masih `running` akan mencoba lagi
atau tidak percaya tombolnya.

- Setelah Stop diklik: tombol → "Stopping…", mikro-copy di panel
  ("menunggu langkah aktif selesai — tidak ada wave baru dimulai").
- Event terminal sudah ada; cukup wiring state di frontend.

**Backend:** tidak ada.

## R4 — Visualisasi wave (P1)

Scheduler sudah mengelompokkan step per wave dari `dependsOn`; UI menampilkan
daftar datar dengan teks "after \<id\>". Render grup per wave:

- **Wave 1** (2 step paralel) → **Wave 2** → …; progress per wave lebih
  informatif daripada persentase linear; badge "N parallel" jadi redundan.
- Grup tetap satu `ol` logis dengan heading grup — screen reader tidak
  kehilangan urutan (pola aksesibilitas `role="progressbar"` yang sudah ada
  dipertahankan).
- Indikator retry kecil (⟳) pada step yang pernah retry — butuh
  `retries_used` diekspos ke event.

**Backend:** pengayaan event kecil (`retries_used` pada `StepStarted`/
`StepFailed` atau event terpisah). Wave bisa dihitung murni di frontend dari
`dependsOn` (sudah lengkap di `PlanStarted`).

## R5 — Artifact yang berbahasa manusia (P1)

`ArtifactRow` merender `"handle: mem1"` dalam mono — jargon internal (kunci
paging `artifact_recall` subagent). Jangan pernah tampilkan handle mentah.

- `handle` → chip netral "result saved · #N".
- `structured` → label jenis ("query result", "market data"), bukan
  "structured result" generik — perlu kind label dari backend.
- `file` chip (preview bridge) sudah bagus — jadikan pola baku untuk semua chip.

**Backend:** pengayaan kecil `ArtifactInfo` (kind label untuk
`Structured`/`Handle`).

## R6 — Riwayat replan sebagai versi (P1)

`planRevised` sudah menyimpan snapshot plan v1 sebelum re-seed. Tinggal
permukaannya:

- Header panel: "Plan v2" + collapse "v1 (3/5 selesai — direvisi setelah
  langkah export gagal)".
- User melihat resume/revisi sebagai satu siklus; kegagalan v1 tidak hilang.

**Backend:** tidak ada.

## R7 — Resume & failure menawarkan dua jalan (P1)

Saat plan gagal permanen (replan habis budget `MAX_REPLANS = 1`), tawarkan
berdampingan:

- "Resume plan (lanjut dari langkah 3)" — jalankan plan sama, step selesai
  di-skip dari `supervisor_step_results`.
- "Coba lagi dengan rencana baru" — `plan_task` ulang.

`errorKind` yang kini typed dipakai untuk copy: `timeout` → "kehabisan waktu —
bisa di-resume"; `tool` → tampilkan error tool apa adanya.

**Backend:** tidak ada.

## P2 — Polish "supervised"

- **Elapsed time per step `running`** — satu-satunya sinyal hidup antar
  event; membuat timeout 60s terasa terpantau. Frontend-only (timestamp dari
  `StepStarted`).
- **Panel completed mengecil** — setelah `planCompleted`, lipat daftar step
  jadi ringkasan satu baris (✓ 5/5 · 2 file · lihat detail). Jawaban final
  hidup di chat; panel tidak duplikasi body besar (hormati wire preview 2000
  char dari backend).
- **Attention nudge saat selesai** — judul session/status rail berubah +
  subtle ping saat plan selesai di luar viewport.

## Yang sudah benar — jangan diubah

- Plan sebagai source of truth terpisah dari chat.
- `PersistedPlan` terstruktur → riwayat me-replay plan, bukan prose.
- Token-driven colors di `StepIcon` (catatan critique 2026-09-04 — diikuti).
- "No artificial sequencing" — wave grouping di R4 adalah struktur asli dari
  `dependsOn`, bukan sequencing buatan; konsisten dengan prinsip ini.
- Snapshot sebelum replan (R6 tinggal permukaannya).
- `role="progressbar"` + aria-valuenow.

## Verifikasi

- `bun run build` (frontend: tsc + vite) untuk tiap item.
- Skenario manual: plan dengan confirmation gate, plan gagal → resume,
  plan gagal → replan, stop di tengah wave, riwayat sesi terbuka ulang
  (replay `PersistedPlan`).
- Aksesibilitas: wave groups tetap satu list logis; kontras ikon status
  tetap token-driven.
