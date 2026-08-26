# Kawai — Visual Layout per Agent

Kerangka layar sama untuk semua agent: **rail agent (kiri) · chat (tengah) · sesi (kanan)**,
plus **panel konteks (canvas)** di kanan chat — hanya untuk agent yang punya sumber data.
Yang membedakan antar agent: ikon & subtitle di rail, pil pertanyaan awal, isi canvas,
dan bentuk kartu hasil alat di dalam chat.

> Diagram sengaja dibuat lebar — buka di layar/editor lebar agar tidak melipat.

Legenda: `▸` agent aktif · `[think]` mode thinking · `[canvas]` toggle panel konteks ·
`[sess]` toggle panel sesi · `[@]` rujuk file · `[mic]` dikte suara.

---

## 1. 💼 Office Agent — docs · pdf · sheets · chat

Canvas aktif, dua tab: **Sesi ini** dan **Perpustakaan**. File yang ditempel ke sesi
bisa dicari agent sepanjang percakapan itu.

```text
┌────────────────────┬──────────────────────────────────────────────────────┬────────────────────────────────────┬──────────────────────────┐
│kawai         [<]   │Office agent       [think] [canvas] [sess]            │Knowledge        Link  + Files      │SESSIONS            New   │
├────────────────────┼──────────────────────────────────────────────────────┼────────────────────────────────────┼──────────────────────────┤
│                    │                                                      │                                    │[cari sesi...]            │
│AGENTS              │                                                      │                                    │                          │
│▸ Office            │                                                      │                                    │HARI INI                  │
│  Binance           │                                                      │                                    │  ● Analisa PDF           │
│  Analytics         │                                                      │                                    │  ● Laporan mingguan      │
│                    │                 ╭──────────────────────────╮         │                                    │KEMARIN                   │
│                    │                 │ Ringkas PDF laporan ini  │         │                                    │  ○ Riset harga           │
│                    │                 ╰──────────────────────────╯         │                                    │  ○ Draft invoice         │
│                    │                                                      │                                    │                          │
│                    │Baik — ini ringkasan isi laporan:                     │                                    │                          │
│                    │Pendapatan Q2 naik 12%, didorong                      │[Sesi ini]  Perpustakaan            │                          │
│                    │segmen ritel. Margin bersih 18%.                      │                                    │                          │
│                    │                                                      │SESI INI                            │                          │
│                    │╭──────────────────────────────╮                      │laporan.pdf    ✓ siap   buka ✕      │                          │
│                    ││ alat: pdf_extract · selesai  │                      │anggaran.xlsx  … mengindeks         │                          │
│                    │╰──────────────────────────────╯                      │                                    │                          │
│                    │                                                      │"Agent dapat mencari dokumen"       │                          │
│                    │• Rekomendasi: ekspansi gudang                        │"ini di sepanjang percakapan."      │                          │
│                    │  regional ditunda ke Q4.                             │                                    │PERPUSTAKAAN              │
│                    │                                                      │kontrak.docx   +  buka  ✕           │                          │
│                    │                 ╭──────────────────────────╮         │data2024.xlsx  +  buka  ✕           │                          │
│                    │                 │ @laporan.pdf          ×  │         │catatan.txt    +  buka  ✕           │                          │
│                    │                 │ Tanya apa saja…          │         │                                    │                          │
│                    │                 │ [@] [mic]        [kirim] │         │                                    │                          │
│                    │                 ╰──────────────────────────╯         │                                    │                          │
│D  demo  [tema]     │                                                      │                                    │                          │
└────────────────────┴──────────────────────────────────────────────────────┴────────────────────────────────────┴──────────────────────────┘
```

Catatan tampilan:

- Layar awal: pil saran `( Summarize this PDF ) ( Create a weekly report ) ( Merge these invoices )`.
- Tab Perpustakaan = semua dokumen terimpor; tombol `+` menempelkan file ke sesi.
  Sebelum ada sesi, tab ini berlabel **Documents**.
- Header canvas punya dua aksi global: **Link** (tempel transkrip YouTube) dan **+ Files**
  (impor docx/xlsx/pptx/pdf/gambar).
- Baris file punya status (`✓ siap`, `… mengindeks`) + aksi `+ buka ✕`.

---

## 2. 📈 Binance Agent — crypto · market data · TA

Tanpa canvas sama sekali: tidak ada toggle `[canvas]`, tidak ada drawer knowledge.
Chat melebar mengambil semua ruang antara rail dan panel sesi.

```text
┌────────────────────┬──────────────────────────────────────────────────────────────────────────────────┬──────────────────────────┐
│kawai         [<]   │Binance agent          [think] [sess]                                             │SESSIONS            New   │
├────────────────────┼──────────────────────────────────────────────────────────────────────────────────┼──────────────────────────┤
│                    │                                                                                  │[cari sesi...]            │
│AGENTS              │                                                                                  │                          │
│  Office            │                                                                                  │HARI INI                  │
│▸ Binance           │                                                                                  │  ● Analisa BTC daily     │
│  Analytics         │                            ╭───────────────────────────╮                         │  ● RSI ETH               │
│                    │                            │ Cek harga BTC sekarang    │                         │                          │
│                    │                            ╰───────────────────────────╯                         │KEMARIN                   │
│                    │                                                                                  │  ○ Depth SOLUSDT         │
│                    │BTCUSDT bergerak di $67.420, naik                                                 │                          │
│                    │+2,1% dalam 24 jam. Volume tinggi                                                 │                          │
│                    │pada sesi Asia.                                                                   │ARSIP (2)  ▸              │
│                    │                                                                                  │                          │
│                    │╭─ alat: binance_price ─────────────────────────────╮                             │                          │
│                    ││ last 67,420.5   bid 67,418.0   ask 67,423.0       │                             │                          │
│                    ││ perubahan 24 jam: +2.1%   volume: 28,451 BTC      │                             │                          │
│                    │╰───────────────────────────────────────────────────╯                             │                          │
│                    │                                                                                  │                          │
│                    │╭─ alat: binance_ta_analyze ────────────────────────╮                             │                          │
│                    ││ RSI(14) 61.8   MACD +12.4   EMA20 > EMA50         │                             │                          │
│                    ││ sinyal: momentum bullish moderat                  │                             │                          │
│                    │╰───────────────────────────────────────────────────╯                             │                          │
│                    │                                                                                  │                          │
│                    │╭───────────────────────────────────────────────────╮                             │                          │
│                    ││ Tanya apa saja…                                   │                             │                          │
│                    ││ [@] [mic]                               [kirim]   │                             │                          │
│                    │╰───────────────────────────────────────────────────╯                             │                          │
│D  demo  [tema]     │                                                                                  │                          │
└────────────────────┴──────────────────────────────────────────────────────────────────────────────────┴──────────────────────────┘
```

Catatan tampilan:

- Layar awal: pil saran `( Analyze BTCUSDT on the daily ) ( RSI and MACD for ETHUSDT )
  ( Order book depth for SOLUSDT )`.
- Hasil pasar dirender sebagai kartu ringkas di alur chat — pasangan label–nilai,
  tanpa tabel berat.

---

## 3. 📊 Analytics Agent — csv · parquet · excel

Canvas paling lengkap: tiga tab — **Sesi ini**, **Perpustakaan**, **Database**.
Satu-satunya agent dengan kartu onboarding data.

```text
┌────────────────────┬──────────────────────────────────────────────────────┬────────────────────────────────────┬──────────────────────────┐
│kawai         [<]   │Analytics agent     [think] [canvas] [sess]           │Knowledge        Link  + Files      │SESSIONS            New   │
├────────────────────┼──────────────────────────────────────────────────────┼────────────────────────────────────┼──────────────────────────┤
│                    │                                                      │                                    │[cari sesi...]            │
│AGENTS              │                                                      │                                    │                          │
│  Office            │                                                      │                                    │HARI INI                  │
│  Binance           │                                                      │                                    │  ● Penjualan agustus     │
│▸ Analytics         │                        ╭────────────────────────────╮│                                    │                          │
│                    │                        │ Total penjualan per        ││KEMARIN                             │                          │
│                    │                        │ kategori bulan ini?        ││  ○ Top pelanggan                   │                          │
│                    │                        ╰────────────────────────────╯│                                    │                          │
│                    │                                                      │[Sesi ini] [Perpustakaan] [Database]│                          │
│                    │Berikut breakdown penjualan:                          │                                    │DATABASE                  │
│                    │                                                      │                                    │postgres-prod   ✓ tersambu│
│                    │╭─ data_query ── Chart | Table ── ↓CSV ╮              │sqlite-lokal    ✓ tersambung        │                          │
│                    ││ Elektronik  ███████████████  12.4k   │              │                                    │                          │
│                    ││ Fashion     █████████        7.9k    │              │[+ profil baru]                     │                          │
│                    ││ Olahraga    ██████          5.1k     │              │                                    │                          │
│                    ││ Mainan      ███             2.8k     │              │                                    │                          │
│                    ││ 1.204 baris · diagregasi · batas 50  │              │                                    │                          │
│                    │╰──────────────────────────────────────╯              │                                    │                          │
│                    │                                                      │                                    │                          │
│                    │╭──────────────────────────────────────╮              │                                    │                          │
│                    ││ @penjualan.csv  @target.xlsx    ×   │               │                                    │                          │
│                    ││ Tanya apa saja…                      │              │                                    │                          │
│                    ││ [@] [mic]                  [stop ■] │               │                                    │                          │
│                    │╰──────────────────────────────────────╯              │                                    │                          │
│D  demo  [tema]     │                                                      │                                    │                          │
└────────────────────┴──────────────────────────────────────────────────────┴────────────────────────────────────┴──────────────────────────┘
```

Catatan tampilan:

- Kartu hasil `data_query`: toggle **Chart | Table** kiri atas, unduh **CSV** kanan,
  grafik batang hijau (bar tertinggi solid, sisanya transparan), kaki catatan
  `1.204 baris · diagregasi · batas 50`.
- Saat streaming, tombol kirim composer berubah menjadi **stop ■**.
- Tab **Database** mengelola profil SQL: tambah/edit/uji/hapus + status `✓ tersambung`.

### Layar awal (belum ada percakapan)

```text
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                         ╭──────╮                               │
│                         │ ikon │                               │
│                         ╰──────╯                               │
│                                                                │
│                       Analytics agent                          │
│      Analisis data tabular lewat pertanyaan bahasa natural.    │
│                                                                │
│   ( Total penjualan per kategori bulan ini )                   │
│   ( Rata-rata transaksi di atas $500 )                         │
│   ( Top 10 produk by pendapatan )                              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Kartu onboarding (agent data, belum ada file & database)

Muncul menggantikan pil saran hanya bila: belum ada sesi DAN belum ada file tabular
(csv/xlsx/parquet) DAN belum ada profil database.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐                  │
│   ╎  Belum ada sumber data tersambung               ╎                │
│   ╎                                                 ╎                │
│   ╎  Impor file CSV / Excel / parquet, atau         ╎                │
│   ╎  hubungkan database SQLite / Postgres, lalu     ╎                │
│   ╎  tanyakan apa saja seperti "Total penjualan     ╎                │
│   ╎  per kategori".                                 ╎                │
│   ╎                                                 ╎                │
│   ╎   [ impor file ]      [ hubungkan database ]    ╎                │
│   └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘                  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Tombol **hubungkan database** membuka canvas langsung melompat ke tab Database.

### Anatomi composer (semua agent)

```text
┌────────────────────────────────────────────────────────────────────────┐
│  chip file terlampir:  (@ penjualan.csv  ×)  (@ target.xlsx  ×)        │
├────────────────────────────────────────────────────────────────────────┤
│  Ketik pesan untuk agent…                                      ↑       │
│  (panah atas = ulangi pesan terakhir)                                  │
├────────────────────────────────────────────────────────────────────────┤
│  [@ rujuk file]  [ mic dikte ]                      [ kirim ➤ ]        │
│  saat streaming tombol kanan berubah jadi        [ stop ■ ]            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Mobile (< lebar tablet)

Semua panel samping menjadi drawer overlay; backdrop gelap, ketuk luar atau Esc untuk menutup.

```text
┌──────────────────────────────┬──────┬──────────────────────────────────┐
│┌──────────────────────────┐  │      │┌─────────────────────────┐       │
││ ☰  Nama sesi    T S ▦ ▤ │   │      ││ ☰  Nama sesi        …  │        │
│├──────────────────────────┤  │      │├─────────────────────────┤       │
││                          │  │      ││▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│       │
││      percakapan chat     │  │      ││▓▓  Knowledge      [×] ▓│        │
││      memakai lebar penuh │  │      ││▓▓ ┌──────────────────┐ ▓│       │
││                          │  │      ││▓▓ │ Sesi ini         │ ▓│       │
││ ╭──────────────────────╮ │  │      ││▓▓ │ Perpustakaan ◄   │ ▓│       │
││ │ Ketik pesan…     ➤ │ │    │      ││▓▓ │ Database         │ ▓│       │
││ ╰──────────────────────╯ │  │      ││▓▓ └──────────────────┘ ▓│       │
│└──────────────────────────┘  │      │└─────────────────────────┘       │
│ drawer agents (dari kiri)    │      │ drawer sessions/knowledge        │
│ tampil sebagai overlay di    │      │ latar belakang digelapkan,       │
│ layar penuh saat <768px      │      │ ketuk luar untuk menutup         │
└──────────────────────────────┴──────┴──────────────────────────────────┘
```

---

## 5. Ringkasan perbedaan antar agent

| Elemen layout              | 💼 Office           | 📈 Binance           | 📊 Analytics            |
|----------------------------|---------------------|----------------------|-------------------------|
| Ikon rail                  | Briefcase           | TrendingUp           | BarChart3               |
| Subtitle                   | docs · pdf · sheets | crypto · market · TA | csv · parquet · excel   |
| Pil saran                  | EN — kerja dokumen  | EN — pasar crypto    | ID — pertanyaan data    |
| Panel konteks (canvas)     | ✔ — 2 tab           | — tidak ada          | ✔ — 3 tab               |
| Tab Database               | —                   | —                    | ✔                       |
| Kartu onboarding data      | —                   | —                    | ✔ saat kosong           |
| Drawer knowledge di mobile | ✔                   | —                    | ✔                       |
| Kartu hasil khas           | ekstrak/ringkas dok | harga · depth · TA   | chart/tabel + unduh CSV |

Identik di semua agent: header chat satu baris (judul sesi + status model + toggles),
composer kapsul terpusat maksimal ±672px, panel sesi 240px dengan grup tanggal +
bagian Arsip lipat, footer rail (avatar inisial + user + tema), serta kartu konfirmasi
impor yang muncul di atas composer saat diperlukan.

## 6. Agent tak dikenal

Agent dari katalog backend yang belum ada di peta frontend tampil generik:
ikon bot, subtitle "agent", tanpa pil saran, tanpa canvas — pola layarnya seperti Binance
(chat penuh).
