# PLAN — Follow-up Composer

Sadar-deliverable goal composer: setelah sebuah run selesai, composer berubah dari input kosong
menjadi pintar — quick-action chips, placeholder kontekstual, dan auto-quote deliverable terakhir
ke dalam goal — sehingga revisi/enhance hasil run sebelumnya jadi satu klik + satu ketikan.

Brainstorm lengkap: percakapan desain 2026 (ringkasan di bawah). Tidak mengubah backend scheduler —
run follow-up tetap plan baru yang dibekali hasil run lama via `session_step_results`.

## Model mental (penting, mengikat semua fase)

- **Follow-up = run baru**, bukan kelanjutan steps existing. Plan baru, steps baru, planKey baru.
- Steps baru membaca hasil run lama lewat `session_step_results` (cross-run, session-scoped,
  lintas planKey by design). Resume planKey-sama yang skip completed steps hanya untuk retried
  plan yang gagal — bukan jalur follow-up.
- UI run view tetap satu run aktif; "menyambung" ke run lama ditampilkan visual saja (Fase 4).
- Composer selalu free-form. Chips = shortcut, bukan batasan. **Tidak ada yang blocking.**

## Keputusan desain

| # | Keputusan | Alasan |
|---|---|---|
| 1 | Chips statis hardcoded sebagai baseline | Deterministic, nol latency, nol failure mode; aturan project: hardcode when possible |
| 2 | Chips dinamis via `remote_llm::reason` sebagai enhancement, non-blocking, statis-first | Pool sudah fallback ke Gemma on-device saat vault kosong; swap di background |
| 3 | Trigger chips dinamis tepat di event `finished` | Nilai chips dinilai dari ISI deliverable; sebelum writer selesai = tebakan yang sering meleset |
| 4 | Auto-quote di frontend (bukan agent-side detection) | Frontend sudah punya full deliverable di state; zero call; planner prompt tetap "goal verbatim" |
| 5 | Excerpt ≤ 800 chars di quote, full body tetap di `supervisor_step_results` | Quote memberi planner kepastian referensi; full body dibaca agent via tool saat perlu |
| 6 | planKey TIDAK dikirim ke LLM chips, HANYA di blok quote ke planner | Chips hanya butuh isi teks; planKey = lookup key presisi untuk `session_step_results` |
| 7 | Intent follow-up = state eksplisit frontend (`followUp`), BUKAN regex pada teks goal | Frontend selalu tahu intent dari sinyal UI; regex punya dua failure mode dan butuh daftar kata per bahasa |
| 8 | Flag tidak jadi param `plan_task` — terwujud sebagai ada/tidaknya blok quote di goal string | Blok quote sudah self-describing bagi planner; menghindari dua sumber kebenaran yang bisa kontradiktif |
| 9 | Chip = `followUp` otomatis; submit bebas post-deliverable = SARAN opt-in, bukan auto-quote | Auto-quote pada goal bebas yang tak berhubungan mem-bias planner & buang konteks 800 chars; saran sama deterministiknya tanpa heuristik |
| 10 | Dua bentuk goal: `quotedGoal` (dikirim ke `plan_task`) vs `cleanGoal` (userGoal, title, plan record) | Quote yang menempel di goal string bisa bocor ke `plan.goal` (planner boleh rewrite) dan ke title seeding — kontrak verbatim `userGoal` harus terjaga |
| 11 | Excerpt di-sanitize: tag `<previous-deliverable>`/`</previous-deliverable>` di-strip dari excerpt | Excerpt adalah konten LLM yang di-quote verbatim — deliverable berisi tag itu bisa spoof boundary blok (murah, preventif) |
| 12 | `suggest_followups` return `Vec<String>` polos (bukan `Result`) | logic.rs fallback internal ke `Vec::new()` dan tak pernah error; `Result` = noise, kegagalan = chips statis tetap |

---

## Fase 1 — Chips statis + placeholder kontekstual (frontend only)

File: `frontend/src/features/workbench/components/workbench-page.tsx`,
`frontend/src/features/workbench/` (composer + hook).

### 1.1 Chips statis

Konstanta di workbench (hardcoded, sesuai rulebook config):

```tsx
const FOLLOW_UP_CHIPS = [
  { icon: "✨", label: "Enhance",         prefix: "Enhance the previous deliverable: " },
  { icon: "➕", label: "Expand",          prefix: "Expand the previous deliverable with more depth and examples: " },
  { icon: "🎯", label: "More actionable", prefix: "Rewrite the previous deliverable to be more concrete and actionable: " },
  { icon: "✂️", label: "Shorter",         prefix: "Condense the previous deliverable, keep the key findings: " },
  { icon: "✍️", label: "Change tone",     prefix: "Rewrite the previous deliverable in a different tone: " },
  { icon: "🌐", label: "Translate",       prefix: "Translate the previous deliverable to: " },
];
```

Behavior:
- Render hanya saat run terakhir berakhir `finished` DAN `deliverableStep.state === "completed"`
  (baris chips di atas composer; sudah ada guard sejenis untuk export button).
- Klik → set value composer = `prefix`, fokus input, cursor di akhir.
- Submit-guard composer yang sudah ada (goal under review) tetap berlaku — chips disabled juga.

### 1.2 Placeholder kontekstual

```tsx
const placeholder = lastRunCompleted && deliverableCompleted
  ? "Follow up on the previous deliverable… (e.g. expand section 2, change tone)"
  : "Describe your goal…";
```

### Verify Fase 1
`bun run typecheck && bun run build`. Manual: jalankan satu goal sampai finished → chips muncul,
klik chip mengisi composer, goal fresh masih normal.

---

## Fase 2 — Auto-quote deliverable (frontend only)

### 2.1 State `followUp` eksplisit (bukan regex)

Intent follow-up adalah state di `use-workbench`, ditentukan oleh sinyal UI — bukan ditebak
dari teks goal:

| Sinyal | `followUp` |
|---|---|
| Klik chip follow-up (Fase 1/3) lalu submit | `true` (pasti) |
| Submit bebas di session yang sudah punya deliverable completed | default `false`, tapi tampilkan **saran opt-in** di indicator: `↳ Quote previous deliverable? [include]` — klik untuk set `true` |
| Klik `[×]` di indicator quote | `false` → goal dikirim mentah |
| Session tanpa deliverable completed | `false` (goal fresh pertama) |

Alasan default `false` untuk submit bebas (keputusan #9): auto-quote pada goal bebas yang
sama sekali tak berhubungan ("analyze this CSV") mem-buang attention planner pada 800 chars
yang salah dan bisa mem-bias output ke deliverable lama. Saran opt-in tetap zero-heuristik —
keputusan tetap milik user via satu klik, bukan tebakan.

### 2.2 Bentuk goal yang dikirim ke `plan_task`

Flag TIDAK menjadi parameter `plan_task` baru (keputusan #8) — kontrak planner tetap satu goal
string. `followUp = true` terwujud sebagai penempelan blok quote di bawah ini; blok-nya
self-describing, jadi planner tahu ini kontekstual tanpa sinyal kedua. Flag hanya naik ke
backend resmi bila nanti ada perilaku eksekusi yang bergantung padanya (mis. diff-view).

```xml
<previous-deliverable planKey="{planKey}" session="{sessionId}" chars="{fullLen}">
{excerpt ≤ 800 chars dari deliverable terakhir}
</previous-deliverable>

<user-goal>
{verbatim goal user}
</user-goal>
```

- `planKey` sudah ada di state supervisor (`use-supervisor-plan.ts`), dipersist di plan record.
- `user-goal` tetap utuh — planner prompt melarang mereWRITE goal; blok quote hanya konteks.
- Full body TIDAK ikut — agent membaca penuh via `session_step_results` kalau step-nya perlu.

### 2.3 Dua bentuk goal: `quotedGoal` vs `cleanGoal` (keputusan #10)

Kontrak verbatim WAJIB terjaga — planner boleh me-rewrite `plan.goal`, dan title session
sudah dari pesan pertama. Maka frontend menyimpan DUA string saat `followUp` aktif:

- `quotedGoal` — blok quote + goal; HANYA dikirim ke `plan_task` sebagai input planner.
- `cleanGoal` — goal bersih tanpa blok; dipakai untuk: `userGoal` param di
  `execute_supervisor_plan`, judul run di UI, plan record yang dipersist, dan jalur
  title-seeding. Quote TIDAK BOLEH sampai ke sini.

Excerpt di-quote setelah di-sanitize (keputusan #11): strip semua kemunculan
`<previous-deliverable>` / `</previous-deliverable>` dari excerpt sebelum dibungkus.

Sumber excerpt & `fullLen`: `planCompleted.final_output` TIDAK di-cap di wire
(`supervisor.rs` — cap 2000 chars hanya untuk `stepCompleted` per-step), jadi frontend
punya deliverable PENUH di state saat `finished` — tanpa fetch `supervisor_step_output`.
Catatan: kalau cap policy `final_output` berubah, Fase 2 harus switch ke satu fetch
`supervisor_step_output` untuk sumber excerpt (verify di Fase 2).

### 2.4 Indicator transparansi

Saat `followUp` aktif, di atas composer:

```
↳ Will include: "{judul/goal deliverable terakhir}" (previous deliverable)  [×]
```

Untuk submit bebas post-deliverable (default `false`), indicator tampil sebagai saran:
`↳ Quote previous deliverable? [include]`. User selalu tahu apa yang dikirim ke model.

### Verify Fase 2
`bun run typecheck && bun run build`. Manual e2e: goal 1 (mis. analisis) sampai finished →
goal 2 "tambahkan analisis risiko" → saran quote muncul → include → submit → planner menerima
blok quote (cek stderr/trace planner) DAN `userGoal`/title/plan record tetap goal bersih tanpa
XML → deliverable baru mereferensikan hasil lama. Klik × / tak include → goal terkirim mentah.
Assert juga: excerpt yang mengandung `</previous-deliverable>` tersanitize.

---

## Fase 3 — Chips dinamis (backend op + frontend swap)

### 3.1 Op baru `suggest_followups` (dua wrapper, invariant #2)

- `logic.rs` (pure): `suggest_followups(user_id, excerpt: String) -> Vec<String>`
  → satu panggilan `remote_llm::reason` dengan prompt ringkas:
  > The deliverable below was just produced. Suggest 4 short follow-up requests
  > (≤4 words each, same language as the deliverable) the user is most likely to ask next.
  > Return a JSON array of strings. Deliverable: {excerpt}

  Parse via `remote_llm::reason::extract_json` (fenced/prose-wrapped JSON sudah didukung).
  Fallback: `Vec::new()` pada kegagalan apa pun (frontend tetap menampilkan chips statis).
  Return `Vec<String>` polos, BUKAN `Result` (keputusan #12) — logic fallback internal,
  op tak pernah error; command & route mengikuti bentuk yang sama.
- `commands.rs`: `#[tauri::command]` biasa (RPC) — bukan streaming,
  tanpa cancel registry (panggilan sekali-jalan; biarkan selesai di background).
- `web.rs`: route `POST /api/suggest_followups` di `protected`, `Extension<String>` user id.
- Register di `lib.rs` `generate_handler!`.
- Excerpt dipotong backend di ~2000 chars (materials cap engine lokal aman).

### 3.2 Frontend: statis-first, swap non-blocking

```
event finished ──┬─ render chips statis (instan)
                 └─ spawn: call('suggest_followups', { excerpt })
                    → sukses & hasil non-kosong → swap chips (animasi halus)
                    → gagal/kosong → chips statis tetap
```

- Prompt chips TIDAK menerima planKey/sessionId (keputusan #6).
- Klik chip dinamis → goal = teks chip dilengkapi user + set `followUp = true` (auto-quote Fase 2).
- Desktop-only advantage: `litert` feature membuat pool fallback ke Gemma — chips tetap
  ter-generate tanpa vault key (latency beberapa detik, tidak terlihat karena statis sudah tampil).

### Verify Fase 3
`bun run typecheck && bun run build`; `cargo check`; `cargo check --features web`;
`cargo check -p kawai --no-default-features --features web`; mobile check TIDAK wajib
(tidak ada perubahan shared logic — op baru murni additif; jalankan bila ragu).
Manual: dengan vault kosong + litert on → chips swap ke dinamis dalam ±5–15s;
dengan vault → swap dalam ±2s; pool mati → chips statis selamanya, tanpa error di UI.

---

## Fase 4 — Previous-run rail di run view (UX penyambung, frontend only)

Saat session sudah punya run sebelumnya (`previousRun` ada), render di atas rail run
aktif satu section collapsed — SELALU, bukan hanya saat submit via chip/quote:
setiap goal di session yang sama secara semantik membangun di atas run sebelumnya
(premis keputusan #9), jadi trigger visualnya harus match dengan model data.

```
▼ Run sebelumnya — "Q3 Portfolio Analysis" (4 steps, selesai)
▶ Enhancing… (3 steps)      ← rail aktif seperti biasa
```

Klik untuk buka report run lama di viewer kanan (in-memory full output yang di-capture
saat `planCompleted` run lama; full step reports tetap via `supervisor_step_output`).
Mental model user: "run baru meneruskan run lama" — tanpa backend menggabungkan plan.
Ditambah continuity badge di header viewer: `↳ builds on "<goal lama>" · view` — link
yang membuka report run lama yang sama, agar deliverable baru tidak terasa
"menggantikan" yang lama tanpa penanda.

### Verify Fase 4
`bun run typecheck && bun run build` + manual dua-run e2e.

---

## Landmines & catatan

- **Jangan menjanjikan "lanjut dari step ke-N"** di UI/copy. Follow-up = run baru berbekal hasil
  lama; revisi tetap butuh LLM call (re-sintesis). Revisi non-LLM (ganti angka/tanggal) = jalur
  export → `office_edit_document`, bukan follow-up run.
- **Chips dinamis tidak pernah menunggu apa pun** — statis selalu tampil di t=0; swap best-effort.
- **Jangan pindahkan `followUp` ke param `plan_task`** tanpa kebutuhan eksekusi nyata —
  flag frontend + blok quote sudah cukup (keputusan #8); dua sumber kebenaran = kontradiksi.
- **`followUp` flag adalah state frontend ephemeral** — tidak survive restart/reload.
  Run view memang ephemeral; kalau user reload mid-run, previous-run rail (Fase 4) hilang.
  Acceptable; JANGAN persist flag ke DB — deteksi ulang dari plan record kalau perlu.
- **Jangan kirim full deliverable** ke `suggest_followups` maupun ke quote — excerpt saja;
  full body milik `session_step_results`.
- TS events tidak berubah (tidak ada varian `SupervisorEvent` baru) — tidak perlu
  `export-bindings` kecuali Fase 4 menambah field event (hindari; pakai flag lokal frontend).
- Fase 1–2 murni frontend → tanpa perubahan Rust. Fase 3 satu op baru → ikuti checklist
  "Adding a new operation" di AGENTS.md penuh (commands + web + generate_handler + snake_case).
- Urutan implementasi: Fase 1 → 2 → 3 → 4. Fase 1–2 sudah memberi 80% nilai; Fase 3–4 polish.

## Out of scope (bila suatu saat dibutuhkan)

- Diff-view deliverable revisi (changelog di atas sintesis baru) — perlu perubahan prompt
  `deliverable_writer` + struktur output; tunggu permintaan.
- Ghost-chips selama run berjalan (generate dari partial output) — chips tebakan, sering meleset.
- Multi-run chaining eksplisit di UI (pilih run mana yang jadi basis) — saat ini selalu run
  terakhir; `session_step_results` sudah mendukung lintas-plan bila nanti dibutuhkan.
