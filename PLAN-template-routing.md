# Plan: Template Routing

**Goal**: Sabar multi-step goal不再 selalu bayar 1–6 ronde LLM `plan_task`. Pipeline yang bentuknya sudah diketahui (Stock Research, YouTube Summary, Binance audit, Crypto Screener) diekstrak jadi **template data**, dan goal freeform dicocokkan ke template secara internal — user tidak pernah melihat, tidak pernah memilih, tidak ada satu pun perubahan UI yang terlihat.

**Status**: Fase 1–5 + 7 **IMPLEMENTED** (template registry, deterministic gate live in `plan_task`, `route_log`, `build_registry_for_plan`). Two deviations from the phasing below, both deliberate: route_log landed BEFORE the gate (observability ships with behavior), and **Fase 6 is IMPLEMENTED as LAYER 2** — the keyword gate stays as the precision fast-path (layer 1), and every `plan` decision it makes is re-validated by one small LLM call (`llm_route_resolve`): forced JSON `{template, ticker}` over the closed menu, company names resolved to symbols by the model, then Rust validates registration + universe membership + build before any claim ships. `direct` decisions skip layer 2. Failures/hedges ⇒ planner. Fase 9 (delete the fixed-pipeline commands/forms) is DEAD — the constraint "no user-visible UI change" keeps the forms as the explicit opt-in path.

---

**Layer 1.5 — Laya fast-claim (shipped)**: between layer 1 and layer 2, an
on-device zero-shot classifier (`src-tauri/src/laya_router.rs`, model
litert-community/Laya-Multilingual-LiteRT, assets auto-downloaded on first
grey-band goal) may fast-claim a registered template in ~250 ms when the
rule-extracted facts already fill every required slot. Claims pass the same
build + `enforce_confirmation_policy` machinery and land in `route_log` with
`source="laya"`; declines/missing slots fall through to layer 2 unchanged.
Static guards (greeting/question/direct) always run before it — the PoC
measured the classifier mis-claiming question-shaped goals at 0.96
confidence. Threshold 0.7; the plan review gate is the real safety net.

## 1. Masalah

Supervisor adalah satu-satunya execution path (`ARCHITECTURE.md:48`). Semua submission lewat `plan_task` → `TaskPlan` tervalidasi → `run_plan_with_cancel`. Dua cara jadi multi-step ada di produk:

| Jalur | Bentuk | Biaya |
|---|---|---|
| `plan_task` (composer) | LLM menulis plan dari nol | 1–6 ronde LLM; `PLAN-planner-search-loop.md:106` mengukur 14.6k output token ≈ 3–4 menit |
| `run_stock_research`, `run_youtube_summary`, `run_binance_audit`, `run_crypto_screener` | `TaskPlan` fixed, ditulis di Rust | 0 ronde planning |

Empat pipeline fixed hidup sebagai **command terpisah**, masing-masing dengan command + Axum handler + `build_*_registry` + hook frontend + form (`workbench-page.tsx:556-588`). Consequences:

1. **Duplikasi per vertical baru** —第五 vertical berarti mengulang 5 tempat.
2. **Composer tidak bisa mencapai pipeline fixed** — tanpa chip, desk/youtube/audit tidak bisa dijalankan sama sekali.
3. **Bentuk yang sudah ditulis ulang oleh LLM** — planner tidak tahu bahwa "analisis NVDA" punya struktur 7 wave yang sudah ada di `crates/engines/desk/src/plan.rs`.

Yang **bukan** masalah: `PLAN-planner-search-loop.md:101` mengukur ≈40–60% recall untuk tool search single-shot. Itu open retrieval atas ~144 tool — task yang jauh lebih sulit daripada mencocokkan 4 nama template, tapi arahnya penting: embedding+BM25 satu-pass tidak bisa diandalkan untuk keputusan routing, hanya untuk pre-filter kandidat.

---

## 2. Prinsip

### 2.1 Template adalah data, bukan kode

`desk` sudah membuktikan polanya: topologi (wave, dependensi, timeout, `on_error`) di Rust, isi per step di LLM (`desk_role` tool). Yang dibutuhkan adalah generalize pola itu ke registry, bukan invensi runtime baru.

### 2.2 LLM adalah router atas menu tertutup, bukan penilai

| Bentuk | Verdict |
|---|---|
| *"Apakah tugas ini sulit? Perlu workflow?"* | ❌ Self-assessment. Tidak terkalibrasi, tidak bisa di-replay, tidak bisa ditagih ke concrete |
| *"Goal ini cocok template yang mana?"* | ✅ Klasifikasi atas himpunan bernama. Linearity jauh lebih tinggi, dan output-nya **pasti executable** karena menunya kita tulis |

Router tidak pernah mengarang bentuk plan. Ia hanya mengembalikan `template_id` dari set terdaftar atau `null`. `id` di luar set → ditolak → fallback `Plan`. Tidak ada jalur yang melewati `validate_plan`.

### 2.3 Prediksi tidak diandalkan; verify yang diandalkan

Confidence dari LLM **tidak terkalibrasi** (model cenderung mengeluarkan 0.8–0.9 untuk hampir semua). Jadi τ di atas `confidence` bukan guard yang bisa dipercaya.

Yang diandalkan: **bentuk run yang sudah terjadi**. Setelah run, supervisor tahu faktanya — tool class apa yang terpakai, berapa retry, berapa replan, apakah plan <2 langkah. Konflik antara route dan bentuk run = `routing_error`. Tidak butuh label manual.

### 2.4 Kerugian dibatasi, bukan akurasi

Target bukan "router benar". Target: tidak ada misroute yang merusak hasil.

- Router salah pilih template → plan muncul di review gate (sudah ada) → user discard. Murah.
- Slot wajib kosong → **jatuh ke `Plan`**, bukan bertanya (§4).
- `Plan` selalu valid dan selalu tersedia sebagai fallback.

### 2.5 Eligibilitas = keanggotaan universe pasar, bukan bentuk simbol

Ditemukan di traffic nyata (2026-10-15): "analisis saham Bank BRI" — keyword `saham` + literal `BRI` berbentuk ticker, dan `BRI` adalah **saham IDX, bukan instrumen Binance**. Gate lama mengklaimnya → pipeline futures 13 langkah yang tidak bisa fetch satu candle pun. Koreksi desainnya: `PlanTemplate::market_bound` mensyaratkan literal berada **di dalam listing bursa itu sendiri** (`binance::usdm_symbols` = `exchangeInfo`, self-updating, nol kurasi), dan fail-closed — universe tidak tersedia ⇒ tidak ada klaim ⇒ planner.

Kasus ketiga, hari yang sama: `analisis saham Bank BRI` lolos MESKIPUN universe check terpasang — `BANK` adalah koin meme yang terdaftar di Binance, dan kata "Bank" di goal adalah member yang sah. Koreksinya: `MarketUniverse` memisahkan subset **EQUITY** (`underlyingType: EQUITY` — data bursa), dan goal ber-intent ekuitas (`saham`/`stock`) hanya boleh teresolve ke subset itu — di lapis 1 DAN di validasi klaim lapis 2. Simbol non-ekuitas tetap sah untuk goal tanpa intent ekuitas (`analisis teknikal BANK` → desk, itu koinnya memang).

Dua pelajaran lanjutan dari kasus yang sama: **case** — user menulis "nvidia"/"nvda", bukan "NVDA", jadi kandidat simbol diekstrak case-insensitive dan `baseAsset` exchange dipakai sebagai bentuk kanoniknya ("NVDAUSDT" → "NVDA"); dan **nama perusahaan** ("nvidia" → NVDA) adalah resolusi semantik yang sengaja TIDAK ditebak di gate — ia jatuh ke planner hari ini dan menjadi pekerjaan router Fase 6.

Prinsip umumnya: **yang didaftar bukan dunia (bahasa, puluhan juta perusahaan), melainkan yang bisa dilayani pipeline** — dan kapabilitas pipeline selalu berhingga karena dibangun di atas sumber data finite. Lapisan keyword adalah fast-path presisi; recall untuk bahasa bebas adalah tugas lapisan semantik berikutnya (embedding goal ↔ purpose template), dibuka setelah `route_log` menunjukkan volume miss-nya.

---

## 3. Batasan keras: tidak ada perubahan UI yang terlihat

Routing terjadi **di dalam `plan_task`**, yang sudah jadi backend op. Landasan faktual:

- `use-workbench.ts:715` mengirim `supervisor.planAndRun(quotedGoal, sid, "auto", trimmed)` — `agentId` selalu `"auto"`, bukan pilihan user. Dari sisi frontend `plan_task` sudah kotak hitam yang mengembalikan plan.
- `parseReview` (`plan-reducer.ts:95-108`) membaca `p.goal` + `p.steps` secara struktural; field top-level lain diabaikan. Plan diteruskan opaque ke `execute_supervisor_plan`.
- Composer **hari ini sudah selalu lewat review gate**. Jadi plan dari template arrive di tempat yang familiar — tidak ada elemen baru yang muncul.

Yang eksplisit **tidak** ada:

| Usulan | Alasan ditolak |
|---|---|
| Chip template / form baru | User tidak boleh diarahkan ke template |
| Tombol "Bukan ini" di plan review | Visible — affordance baru. Pengaman dibebankan ke review gate yang sudah ada |
| Pesan klarifikasi saat slot wajib kosong | Visible — dan memaksa interaksi. Lihat §4 |
| Menghapus chip + 5 form existing | Visible. Form tetap; klik = dapat pipeline itu, seperti sekarang |

Konsekuensi yang harus diterima secara jujur: **kesalahan routing tidak bisa dikoreksi user mid-flight** — hanya sebelum run. Review gate yang sudah ada mengompensasi sepenuhnya (prune / edit / discard).

---

## 4. Contract

```rust
// crates/router/src/template.rs
pub struct PlanTemplate {
    pub id: &'static str,                 // "desk"
    /// Satu baris — baris yang dibaca LLM router.
    pub purpose: &'static str,
    /// Deliverable kinds yang boleh diklaim template ini.
    pub domains: &'static [&'static str],
    /// Kontrak ekstraksi slot — BUKAN metadata presentasi.
    pub slots: &'static [Slot],
    pub build: fn(&ResolvedSlots) -> Result<TaskPlan, String>,
}
pub struct Slot {
    pub name: &'static str,
    pub required: bool,
    pub hint: &'static str,
}
```

```rust
// crates/router/src/route.rs — PURE: sync, tanpa I/O, tanpa LLM
pub enum Route {
    Template(&'static PlanTemplate),
    Plan,
    Direct,
}
pub struct RouteDecision {
    pub route: Route,
    pub confidence: f64,
    pub source: RouteSource,   // Rule | Llm | Fallback  (Llm baru)
    pub offered: Vec<&'static str>,
}
```

`route.rs` sengaja tidak async. Begitu keputusan masuk pure function, ia bisa di-replay dengan fixture dan di-eval tanpa provider — itu alasan utama LLM tidak memegang keputusan.

### Bentuk panggilan router

Satu completion, JSON dipaksa, ~200 token output:

```jsonc
{ "template": "desk" | null,
  "slots": { "ticker": "NVDA", "domain": "stock", "tradeDate": "today" },
  "confidence": 0.0 }
```

### Resolusi

```text
1. Fakta deterministik dari goal (deliverable kind, ticker/link literal, keyword domain)
2. Kalau ≥1 template klaim dengan specificity ≥ τ DAN semua slot required terisi → Template
3. Else grey band → 1 ronde router LLM atas menu tertutup
   ├─ template_id valid + slot lengkap → Template
   └─ null / id tak dikenal / parse gagal → Plan
4. Plan
```

Fallback ke `Direct` dicadangkan untuk goal pendek tanpa tool; `Direct` = satu step ke deliverable writer (`supervisor.rs:3626` `synthesize_final_answer`), nol token.

**Slot wajib kosong tidak pernahasks.** Langsung `Plan`. Planner LLM akan mencari sendiri (atau memang tidak butuh). Ini invisible dan selalu aman karena `Plan` selalu valid.

### Precedent: menentukan diam-diam

`supervisor.rs:1142-1158` — kalau LLM memilih `deck_writer` tapi goal tidak punya intent slide/deck/ppt, writer di-strip deterministik. Tidak ada dialog, tidak ada pilihan. Persis pola yang diminta: sistem punya preferences, user tidak diberi beban untuk选择一个.

Preseden itu juga cautionary: strip terjadi **sesudah** parse, jadi biayanya satu planning round terbuang. Untuk template, decision harus **sebelum** planning — plan template tidak butuh planning round sama sekali.

---

## 5. Manifestasi: text generation

Template `longform_report`, owned di Rust, diisi LLM per step:

| Step | Tool | Artifact |
|---|---|---|
| `gather` | `knowledge_search` ∥ `web_read` | `materials` |
| `outline` | writer step | `outline` |
| `draft` | writer step ×N (paralel) | `sections[]` |
| `critique` | writer step | `notes` |
| `compose` | writer step | → deliverable |

Bentuk plan deterministik; yang varies hanya `task` brief per step — pembagian yang sudah dipakai `desk`. Goal pendek ("tulis satu paragraf") → `Plan` atau `Direct` → satu step ke writer.

Profil biaya:

| Route | Ronde LLM sebelum step pertama |
|---|---|
| Template | 0 |
| Direct | 0 |
| Plan (fallback) | 1–6 |

Planner jadi **fallback**, bukan default. Ini satu-satunya perubahan perilaku besar.

---

## 6. Risiko teknis: registry

`desk_role` **tidak ada** di `build_supervisor_registry` — hanya di `build_desk_registry` (`supervisor.rs:1994`). Kalau `plan_task` mengembalikan plan desk lalu `execute_supervisor_plan` tetap membangun registry dari `agentId = "auto"`, `validate_plan` menolak dengan `RouterError::UnknownTool`. Plan mati sebelum jalan.

Solusi: satu field baru di `TaskPlan`:

```rust
pub template: Option<String>,   // penanda registry; default None
```

`commands.rs:2106` + `web.rs:2836` membacanya untuk memilih builder. Properti:

- Field opsional, default `None` → plan LLM tidak pernah mengisinya, dan **LLM tidak bisa mengarang akses ke template**.
- Taksonomi `AgentDefinition` tidak perlu disentuh.
- Plan key berubah (SHA-256 dari plan JSON) — non-issue, per-run.
- Generated TS kemungkinan ikut dapat field; tidak ada kode frontend yang menulisnya.

---

## 7. Fase

Urutan dependensi, bukan urutan-builder. Fase 1–3 nol risiko dan nol provider.

### Fase 1 — `template.rs` + registry (migrasi `desk`)

`PlanTemplate`, `Slot`, `ResolvedSlots`, registry. `desk` jadi entri pertama; `build_desk_plan` (`crates/engines/desk/src/plan.rs:102`) dibungkus, logikanya tidak berubah.

`run_stock_research` tetap jalan persis seperti sekarang — command, handler, form, hook tidak disentuh.

### Fase 2 — Test komprehensivitas registry

Setiap template wajib lolos `validate_plan` terhadap registry yang dibangun persis seperti runtime (`build_registry_from_toolset`). Mencegah template busuk diam-diam.

### Fase 3 — `route.rs` + `route_eval`

`RouteSource::Llm`, `Route`, `RouteDecision`, `route_from_signals(goal, facts)` — pure, sync.

`src-tauri/examples/route_eval.rs`: fixture `(goal, expected_route)` → confusion matrix. **Offline, tanpa provider.** Fixture ditulis dalam bentuk kalimat user, bukan parameter terisi —自由form entry membuat input jauh lebih kotor, dan itu yang membuat eval representatif terhadap traffic sebenarnya.

Harus mencakup kasus missing-required-slot sebagai ekspektasi **`Plan`**, bukan `Template` — kalau tidak, eval mengukur sistem yang tidak akan dikirim.

### Fase 4 — `TaskPlan.template` + dispatch registry

Field baru + `execute_supervisor_plan`/`_handler` memilih builder. Belum ada routing; hanya jalur teknis.

### Fase 5 — Routing deterministik di `plan_task`

`*facts` deterministik saja, sebelum `remote_llm::reason` dipanggil. Short-circuit seluruh planner loop kalau template claim.

### Fase 6 — Router LLM di grey band

Satu completion (`with_output_cap(~200)`, `with_thinking_disabled()`), dievaluasi hanya terhadap fixture yang benar-benar jatuh di grey band. Targetnya "LLM benar pada kasus yang memang router deterministik tidak bisa putuskan" — bukan "LLM benar pada semua".

### Fase 7 — `route_log` + verify

Migration baru + penulisan di plan terminal.

### Fase 8 — `longform_report`

### Fase 9 — Backlog template dari data

Baca `routing_error` yang对这个分类 tinggi Producing →候选 template berikutnya. Backlog berasal dari data, bukan tebakan.

---

## 8. Observability & KPI

`route_log`: `goal_hash`, `offered`, `chosen`, `slot_fill`, `observed_tools`, `retries`, `replans`, `outcome`.

`src-tauri/examples/route_report.rs` (mengikuti `turn_log_report`):

| Sinyal | Arti | Tindakan |
|---|---|---|
| `Template` → plan <2 langkah | domain terlalu lebar | persempit `domains`, naikkan τ |
| `Template` → slot required kosong | ekstraksi gagal / `domains` salah | perbaiki `hint` slot |
| `Direct` → ≥3 tool class terpakai | router terlalu konservatif | turunkan ambang |
| `Plan` → cluster plan serupa | kandidat template baru | Fase 9 |

Tidak butuh ground truth — bentuk run adalah ground truth.

KPI utama: **menu-hit rate** = penghematan token langsung. Dibiandingkan dengan baseline `PLAN-planner-search-loop.md:106` (14.6k output token per run).

---

## 9. File map

| File | Sifat | Fase |
|---|---|---|
| `crates/router/src/template.rs` | baru | 1 |
| `crates/router/src/route.rs` | baru | 3 |
| `crates/router/src/types.rs` | `RouteSource::Llm`, `TaskPlan.template` | 3, 4 |
| `crates/router/src/lib.rs` | re-export | 1, 3 |
| `crates/engines/desk/src/plan.rs` | dibungkus jadi entri template | 1 |
| `src-tauri/src/supervisor.rs` | routing di `plan_task`; registry hint | 4, 5, 6 |
| `src-tauri/src/commands.rs`, `web.rs` | baca `plan.template` → pilih builder | 4 |
| `src-tauri/migrations/00NN_route_log.sql` | baru | 7 |
| `src-tauri/examples/route_eval.rs` | baru, offline | 3 |
| `src-tauri/examples/route_report.rs` | baru, offline | 7 |

**Tidak ada file frontend yang masuk daftar ini.**

---

## 10. Verifikasi

```sh
cargo test --features litert,office --lib      # registry completeness + route_eval
cargo run --example route_eval --features litert # confusion matrix, offline
cargo check                                    # axum TIDAK boleh compile
cargo check --features web
cargo check --features litert,office
```

Smoke: `run_stock_research` — plan JSON harus **identik** dengan sebelum Fase 1 (regresi byte-level pada `plan_key`).

Runtime (Fase 5+): goal freeform yang cocok `desk` harus menghasilkan plan dengan step `d_*` yang sama seperti jalur form, dan **harus lewat review gate** — bukan auto-run.

---

## 11. Di luar scope

- Menghapus chip / 5 form existing (§3).
- Auto-run untuk template match (meniru `desk` persis). Kalau nanti diinginkan, itu tradeoff eksplisit: review gate hilang, escape hatch hilang.
- Afordanceclarification UI.
- `AgentDefinition` sebagai carrier template — `TaskPlan.template` sudah cukup.
- Mobile/web parity untuk Fase 4 — `web.rs` ikut berubah di fase yang sama karena builder dispatch-nya miror.