# kawai — Mascot Logo Brief (agent girl)

Status: butuh ilustrasi final via gen-AI atau ilustrator. SVG `kawai-d-agent.svg` di
folder ini hanyalah wireframe komposisi — BUKAN final, jangan dijadikan ikon.

## Brand constraints (from kawai product)
- Product: supervisor-driven AI workspace, dark theme, desktop/mobile (Tauri).
- App icon slot: squircle tile, must stay legible at 16 px (dock test).
- Tile background: `#14121A` (near-black, warm).
- Hair / accent: `#FF6B9D` (sakura pink). Lighter accent: `#FF9DBE`, `#FFB3C8`.
- Skin / face: `#F5EDE6` (warm cream). Ink (eyes/mouth): `#2A2433`.

## Anatomi cuteness (referensi: Anya Forger — grammar saja, BUKAN menjiplak karakter)

Angka diukur dari referensi chibi di `design/anya/`. IP: Shueisha — cone hitam,
hairstyle persis, dan wajah Anya dilarang; yang dipinjam hanya proporsi & grammar.

1. Fitur wajah dipadatkan di ~40% BAWAH kepala; dahi tinggi tertutup poni.
   Kepala hampir lingkaran penuh; dagu kecil sedikit runcing.
2. Mata besar: tinggi ≈ 1/3 wajah, tepat di bawah garis poni; iris gelap dengan
   DUA highlight putih (besar atas + kecil bawah); sudut luar sedikit turun.
3. Hidung: tidak ada (atau satu piksel titik). Mulut kecil — oval terbuka
   ("waku") atau kurva smug tertutup. Jangan pernah bibir realistis.
4. Blush oval lembut di bawah mata, tidak pernah bergaris.
5. Satu ornamen siluet pemilik = poni 川 tiga helai + twin buns + ahoge
   (padanan kawai dari cone-nya Anya; jangan pakai cone).
6. Palet maksimal 4: #FF6B9D, #F5EDE6, #2A2433, #14121A (+1 highlight pink).

### Peta ekspresi → state UI (nilai produk dari grammar Anya)
- `heh` smug (mata tertutup, senyum dongak) → run sukses / deliverable selesai
- mata berbinar besar → processing / waku-waku saat plan dieksekusi
- air mata comedy → error state
- mata setengah tertutup → idle / menunggu konfirmasi

## Prompt A v2 — app icon (gimmick: poni = kanji 川, mark konsep A melebur ke karakter)

```
Flat vector app icon, chibi anime girl head, centered, sakura pink hair
(#FF6B9D) with straight bangs split into exactly THREE thick vertical
strands forming the Japanese kanji 川 (kawa) — the middle strand is
contrast cream white (#F5EDE6), the outer two strands stay pink,
two small rounded twin-tail buns at the upper sides, one tiny ahoge curl,
large oval dark eyes (#2A2433) with white highlights, soft pink blush
(#FFB3C8), tiny gentle smile, warm cream skin (#F5EDE6),
rounded-square near-black tile (#14121A), minimal flat vector design,
thick clean shapes, no outlines, no gradients, no text, symmetrical,
silhouette legible at 16 pixels --no text, watermark, 3d render,
realistic photo, call-center headset, microphone, busy details,
gradient mesh, long shadow, stock illustration style
```

## Prompt B v2 — character sheet (state UI), gimmick sama + tanpa vibe call-center

```
Character design sheet, chibi AI assistant girl, head ~40% of height,
sakura pink hair (#FF6B9D), bangs split into exactly three vertical strands
like the kanji 川 with the middle strand cream white (#F5EDE6) — her
signature look, small twin-tail buns, one ahoge curl, large dark eyes,
pink blush, dark near-black (#14121A) headphones (NO microphone boom),
cream and pink outfit, flat vector style, 4 poses on one white sheet:
happy waving, focused typing, thinking, apologizing, consistent character,
thick clean shapes --no text, 3d, realistic, gradient mesh, watermark,
microphone, office phone, stock illustration style
```

### Kenapa v1 generic (pelajaran)
Prompt v1 mendeskripsikan kategori ("kawaii anime girl") → model mengembalikan
rata-rata kategori = clip-art; headset+mic malah memunculkan vibe call-center.
Keunikan datang dari SATU gimmick yang di-encode eksplisit: poni 川 tiga helai
dengan helai tengah kontras = mark konsep A melebur ke karakter. Uji keunikan:
tutup mata dari gambar → kalau poni tiga helainya masih terbaca, itu kawai;
kalau yang terbaca cuma "cewek imut rambut pink", buang.

## Acceptance criteria ikon final
1. Terbaca sebagai karakter imut di 256 px DAN masih terbaca "kepala pink berwajah" di 16 px.
2. Siluet twin-tails jelas terpisah dari wajah (ada celah/negatif space).
3. Maksimal 4 warna: #FF6B9D, #F5EDE6, #2A2433, #14121A (+1 highlight pink opsional).
4. Tanpa teks, tanpa outline gelap di sekeliling karakter (flat clean).

## Setelah art final disetujui
1. Ekspor PNG 1024×1024 (transparan atau tile, konsisten satu pilihan).
2. `bun tauri icon path/to/icon.png` — generate `src-tauri/icons/` lengkap
   (icns/ico/PNG semua platform). Jangan edit manual file ikon satu-satu.
3. Simpan master SVG/PNG di `design/logo/` sebagai source of truth.
