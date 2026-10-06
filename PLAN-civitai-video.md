# PLAN-civitai-video.md

## Generator video Civitai (video lane)

Generator panel menerima lane **video**: teks→video, gambar→video (1–2 slot
frame), dan referensi→video lewat Civitai Orchestration **workflows API** —
bukan `recipes/*`. Fase 2 menambah empat engine (flux3/grok/vidu/hunyuan),
slot frame kedua (first/last), `img2vid:ref2vid`, dan cancel workflow.
Fase 3 menambah **LTX** (2.3/2.5, Dev/Distilled) dan **multi-klip**
(`output.additionalVideos` diimpor sebagai klip terpisah). Fase 4 menambah
**vid2vid:edit** (grok v1.0 — upload video sumber MP4/WebM ≤64MB ke
consumer blob, sniffer mime `ftyp`/EBML; `analyzedDuration` tidak dikirim —
kawai tidak mem-probe durasi video lokal). Kunci vault yang sama
(`kawai-vault/constants::civitai::get_civitai`) membukti kemampuan submit/poll
di kedua jalur (bearer API key adalah subject kelas satu di orchestrator,
`generation-surface.ts:21-22`). Implementasi: klien `crates/integrations/civitai`
(video section), op `logic/civitai.rs`, UI `frontend/src/features/generator/video-generator.tsx` + `video-ecosystems.ts`.

### Wire contract (orchestrator)

| Endpoint | Method | Isi | Response | Catatan |
|---|---|---|---|---|
| `/v2/consumer/workflows?whatif=true` | POST | `{steps:[{$type:"videoGen",input:{engine,…}}],upgradeMode:"manual"}` | `{cost:{base,total},ready,warnings,transactions,modelSubstitutions?}` | **Gratis** — tidak persist, tidak charge; membangun step NYATA di server, jadi 200 = seluruh bentuk input valid |
| `/v2/consumer/workflows` | POST | body sama | `{id,status}` | **Buzz dipotong saat submit**; 429 boleh retry, 5xx/timeout TIDAK (bisa sudah tercharge) |
| `/v2/consumer/workflows/{id}?wait=N` | GET | — | workflow penuh; **202** + snapshot bila hold habis dan masih jalan | long-poll; status lowercase di wire (`succeeded`/`failed` teramati live; `unassigned/preparing/scheduled/processing` dari konstanta civitai) |
| `/v2/consumer/workflows/{id}` | PUT | `{status:"canceled"}` | workflow ter-update | cancel — bentuk `clientUpdateWorkflow` milik `cancelWorkflow` civitai (`workflows.ts:652`) |
| `/v2/consumer/blobs` | POST | `{contentType}` (bearer) | `{uploadUrl}` | presign; lalu POST bytes ke `uploadUrl` dengan `Content-Type` → `{url,…}` — URL inilah yang dikirim di step input |

Hasil sukses: `steps[].output.video = {url, thumbnailUrl?, width?, height?}` —
URL blob **signed dan expired** → wajib diunduh segera (`civitai_video_fetch`).
Multi-klip (LTX batch) menumpuk di `output.additionalVideos` — diimpor
setelah klip utama (`civitai_video_fetch` menerima `additionalUrls`; klip
gagal dicatat di stderr, tidak fatal).

### Registry (`registry.rs` video section ↔ `video-ecosystems.ts`)

Fase 1 — enum divalidasi **live** lewat whatif (26 kombinasi aspect + 5
bentuk engine, 200 semua, 2026-10-05). Fase 2 — ditranskrip dari handler
orkestrator civitai (`ecosystems/*.handler.ts`), status **live-pending**
(jaringan ke civitai sedang diblokir saat implementasi — probe dijalankan
begitu terjangkau; whatif pre-flight panel memvalidasi tiap pick sebelum
spend, jadi enum salah = error cost, bukan pembelian).

| Ecosystem | Engine (wire) | Model | Durasi | Resolusi | Slot frame | Ref2vid | Catatan |
|---|---|---|---|---|---|---|---|
| minimax (default) | `minimax-h3` | — | slider 4–15 | `2K` (pin) | 2 (first/last) | ≤9 (`referenceImages`) | aspect `adaptive` saat ada frame |
| seedance | `seedance` | v2/v2-fast/v2-mini/v2.5 | slider 4–15 | 480p/720p | 1 | ≤9 (`images`) | aspect di txt2vid+ref2vid |
| veo3 | `veo3` | — (`fastMode`) | enum 4/6/8 | — | 1 | ≤3 (`images` + placeholder prompt `[@imageN]`) | pin `version:"3.1"`, enhancer `true` |
| kling | `kling` / `kling-v3` (model `v3`) | v1.6/v2/v2.5-turbo/v3 | legacy enum 5/10; v3 slider 5–15 | — | v3: 2 (`sourceImage`+`endImage`) | v3 ≤7 (`operation:"reference-to-video"` + `images`) | audio v3; negative legacy; enhancer legacy |
| wan | `wan` | v2.5 (`provider:"fal"`) | enum 5/10 | 480p/720p/1080p | 1 | — | pin `frameRate:24` |
| flux3 | `flux` (`version:"v3.0"`) | — | slider 4–20 | 720p/1080p (draft pin 720p) | 2 (operation dari jumlah frame: `imageToVideo`/`firstLastFrameToVideo`) | — | aspect `auto` saat ada frame; `draft` bool |
| grok | `grok` (`version:"v1.5"`, edit: `v1.0`) | v1.5; v1.0 = lane edit | slider 6–15 | v1.5: 480p/720p/1080p; **v1.0: 480p/720p** | 1 | v1.5 ≤7 (`referenceToVideo` + aspect) | operasi camelCase; **v1.0 = `edit-video`** (`videoUrl`, tanpa aspect — video menentukan) |
| vidu | `vidu` (q1) / `vidu-q3` (q3) | q1/q3 | **q1 tanpa durasi**; q3 slider 1–16 | q3: 360p/540p/720p/1080p | q1: 2 (`sourceImage`+`endSourceImage`); q3: `images` array | ≤7 (`images`) | q1: style/movementAmplitude/enhancer; q3: `enableAudio`+`turbo` |
| hunyuan | `hunyuan` | — | enum 3/5 | piksel @480p (tabel `HUNYUAN_DIMS_480P`) | — (txt2vid saja) | — | `cfgScale` 1–10, `steps` 10–30 |
| ltx | `ltx2.3` / `ltx2.5` | v2.3/v2.3-distilled/v2.5/v2.5-distilled | slider 3–20 (**1080p cap 15**) | piksel (tabel `LTX_DIMS_720P/1080P`, identik antar versi) | 2 (`firstFrame`+`lastFrame` — img2vid SELALU `firstLastFrameToVideo`) | — | satu-satunya engine dengan `generateAudio` default **ON**; distilled pin `guidanceScale:1`+`steps:8`; `22b-dev` default cfg 3/steps 30 |

**Sora absen dengan sengaja**: orchestrator live menjawab 400 `"Sora has
been retired by OpenAI… Use another videoGen engine such as veo3, kling-v3
or wan instead"`. **LTX ditunda (fase 3)**: wire-nya mengambil width/height
PIKSEL per-resolusi + varian Distilled/Sulphur — port terberat, permintaan
panel paling rendah. Semua engine `quantity:1`.

**Deviasi sadar dari UI civitai**: `img2vid:first-last` TIDAK menjadi
workflow id terpisah — first/last adalah slot kedua opsional pada
`img2vid`, karena wire-nya identik (vidu q1/kling v3/minimax/flux3 semua
menangani 2 frame di jalur `img2vid` yang sama; flux3 bahkan memilih
operation dari jumlah frame). Hanya `img2vid:ref2vid` yang butuh id baru
(field/operation berbeda).

Harga live per whatif (5s kecuali disebut): seedance v2-mini **490**, wan v2.5
**500**, kling legacy **600**, veo3 fast **1000**, minimax **1020** (6s),
kling-v3 9:16+audio **1460** — audio dan aspect mengubah harga; itu sebabnya
pill ≈ di panel adalah whatif sungguhan, bukan formula.

### Alur (empat op, dua wrapper)

1. **`civitai_video_cost`** — whatif, debounce 700ms di panel. Tidak perlu
   upload: whatif menghargai img2vid **tanpa gambar** (terverifikasi live,
   harga identik). Gagal whatif = submit pasti gagal → footer menampilkan
   error, bukan angka Buzz.
2. **`civitai_video_submit`** (auth, user-bound) — validasi registry dulu
   (`VideoGenParams::validate`), lalu `img2vid`: unduh/decode sumber →
   `POST /v2/consumer/blobs` → upload → URL blob dipakai di step input
   (URL eksternal sembarangan dibukti **500**). Submit → `{workflowId}`.
3. **`civitai_video_status`** — long-poll `wait=15s` per panggilan; frontend
   mem-poll terus selama job aktif. Status dinormalisasi:
   `unassigned/preparing/scheduled → queued`, `processing`, terminal
   `succeeded/failed/expired/canceled`; memgawa `queuePosition` (objek
   `{position,support}` di wire) dan `error` gabungan step.
4. **`civitai_video_cancel`** — `PUT {status:"canceled"}` dari kartu progres;
   panel berhenti mem-poll setelah memanggilnya (best-effort — workflow
   terminal mengabaikannya).
5. **`civitai_video_fetch`** — unduh mp4 sekali (ekstensi dari URL; default
   mp4) → `store::import_as(ArtifactKind::Video,"civitai")` + poster
   thumbnail (best-effort, `ArtifactKind::Image`). Idempotensi = tugas
   caller: fetch dipanggil TEPAT sekali per workflow setelah `succeeded`
   (import selalu membuat file baru).

**Restart-safe**: workflowId + job hidup di localStorage
(`kawai-generator-video-job-v1`); polling dilanjutkan saat panel dibuka ulang;
`status`/`fetch` tidak menyimpan state di memori proses. Timeout praktis
loop: >30 menit sejak submit dianggap gagal (pesan error transport terakhir).

### Keputusan desain

- **Kenapa workflows API, bukan resep**: tidak ada resep video di consumer
  API — image `recipes/imageGen` pun tidak dipakai jalur video civitai
  (`orchestration-new.service.ts` → `createWorkflowStepsFromGraph` → step
  `$type:"videoGen"`). Whatif di workflows juga first-class (di resep image
  diabaikan — terverifikasi), sehingga biaya mahal video bisa ditampilkan
  sebelum consent.
- **Kenapa submit+poll, bukan satu RPC sinkron**: video berjalan menit-bukan-
  detik; RPC sinkron mati di timeout HTTP/proxy dan tidak restart-safe.
  Dua op + long-poll meniru pola klien resmi civitai (SignalR + fallback
  poll 60s → di kawai: poll `wait=15`).
- **Kenapa fetch terpisah dari status**: status dipanggil berulang; bila
  status otomatis mengunduh, dua panggilan berbarengan setelah `succeeded`
  menduplikasi file (import selalu create). Fetch terpisah dipanggil sekali
  oleh panel yang sudah melacak "sudah diimpor" via hilangnya job.
- **Kenapa `quantity:1`**: multi-klip menggandakan Buzz tanpa kontrol UI
  phase-1; LTX-style batch (`additionalVideos`) belum dikonsumsi.
- **Kenapa video bukan bagian panel image**: siklus hidup berbeda (async
  bertahun-detik vs sinkron), form berbeda (durasi/resolusi/audio, tanpa
  LoRA/sampler), dan storage berbeda kind — panel terpisah `video-generator.tsx`
  dengan storage hasil sendiri (`kawai-generator-video-results-v1`).

### UI

Media island Generator (kiri atas): tab **image** ↔ **video** saling
mengalihkan panel (early-return di `GeneratorPage` setelah semua hook);
music/box tetap dekoratif (paritas civitai). Form video: workflow chips,
model chips (kling legacy vs v3 mengubah engine + aturan durasi), durasi
(chips enum / slider untuk v3), resolusi, aspect (txt2vid saja — img2vid
`adaptive`/derivasi frame), toggle audio, seed, negative (sesuai flag
registry). Kartu progres di atas grid hasil: spinner + status + posisi
antrean + elapsed + workflowId (mono, untuk support). Hasil: `<video>`
native (poster thumbnail), klik → file preview. i18n: grup
`videoGenerator` (en/id).

### Probe gratis

```
cd crates
cargo run -p civitai --example live_whatif          # auth + 5 engine + 26 aspect + img2vid-whatif + GET list
cargo run -p civitai --example live_video_whatif    # jalur API publik: validate → input_json → whatif
```

Tidak membelanjakan Buzz. `live_whatif` memuat baterai fase 2 (13 probe
engine + 19 sweep aspect untuk flux3/grok/vidu/hunyuan). `live_generate.rs`
tetap satu-satunya smoke berbayar (image).

### Sisa (belum, sengaja)

Probe live fase 2–4 (flux3/grok/vidu/hunyuan/ltx + edit-video — jaringan ke
civitai sedang diblokir saat implementasi; jalankan `live_whatif` begitu
terbuka), MiniMax-comfy (controlVideo), Sulphur 2 (`diffusionModel` AIR),
LTX prompt enhancer (chained step), Wan 2.7 edit (jalur fal + slot audio),
dan hook deliverable (mp4 tidak bisa di-embed markdown/pdf/docx — tetap di
panel + asset viewer). Generasi sungguhan pertama dari panel tetap
verifikasi end-to-end terakhir (membelanjakan Buzz).
