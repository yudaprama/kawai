# PLAN-civitai-video.md

## Generator video Civitai (video lane)

Generator panel menerima lane **video**: teks→video dan gambar→video lewat Civitai
Orchestration **workflows API** — bukan `recipes/*`. Kunci vault yang sama
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
| `/v2/consumer/blobs` | POST | `{contentType}` (bearer) | `{uploadUrl}` | presign; lalu POST bytes ke `uploadUrl` dengan `Content-Type` → `{url,…}` — URL inilah yang dikirim di step input |

Hasil sukses: `steps[].output.video = {url, thumbnailUrl?, width?, height?}` —
URL blob **signed dan expired** → wajib diunduh segera (`civitai_video_fetch`).
Multi-klip (LTX batch) menumpuk di `output.additionalVideos` — belum dipakai
(quantity pin 1).

### Registry phase-1 (`registry.rs` video section ↔ `video-ecosystems.ts`)

| Ecosystem | Engine (wire) | Model | Durasi | Resolusi | Aspect | Audio | Negative |
|---|---|---|---|---|---|---|---|
| minimax (default) | `minimax-h3` | — | slider 4–15 | `2K` (pin) | 21:9/16:9/4:3/1:1/3:4/9:16 | — | — |
| seedance | `seedance` | v2/v2-fast/v2-mini/v2.5 | slider 4–15 | 480p/720p | 21:9/16:9/4:3/1:1/3:4/9:16 | ✓ | — |
| veo3 | `veo3` | — (`fastMode`) | enum 4/6/8 | — | 16:9/9:16/1:1 | ✓ | ✓ |
| kling | `kling` / `kling-v3` (model `v3`) | v1.6/v2/v2.5-turbo/v3 | legacy enum 5/10; v3 slider 5–15 | — | 16:9/9:16/1:1 | v3 saja | legacy saja |
| wan | `wan` | v2.5 (`provider:"fal"`) | enum 5/10 | 480p/720p/1080p | 16:9/9:16/1:1/4:3/3:4 | — | ✓ |

Semua nilai enum divalidasi **live** lewat whatif (26 kombinasi aspect + 5
bentuk engine, 200 semua, 2026-10-05) — tabel ini adalah kontrak wire yang
bisa dijalankan. **Sora absen dengan sengaja**: orchestrator live menjawab
400 `"Sora has been retired by OpenAI… Use another videoGen engine such as
veo3, kling-v3 or wan instead"`. Pin wajib: veo3 `version:"3.1"` +
`enablePromptEnhancer:true`; wan `frameRate:24`; semua engine `quantity:1`.

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
4. **`civitai_video_fetch`** — unduh mp4 sekali (ekstensi dari URL; default
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

Tidak membelanjakan Buzz. `live_generate.rs` tetap satu-satunya smoke
berbayar (image).

### Sisa (belum, sengaja)

`img2vid:first-last` (slot dua frame), `img2vid:ref2vid` (multi-referensi),
`vid2vid:edit` (upload video ≤64MB), ecosystem lanjutan (LTX/Vidu/Grok/
Flux3Video/Hunyuan/MiniMax-comfy), cancel workflow (`DELETE`), multi-klip
(`additionalVideos`), dan hook deliverable (mp4 tidak bisa di-embed
markdown/pdf/docx — tetap di panel + asset viewer). Fase 1 = fondasi:
cost → submit → poll → fetch yang sudah terbukti live sampai whatif;
generasi sungguhan pertama dari panel adalah verifikasi end-to-end
terakhir (membelanjakan Buzz).
