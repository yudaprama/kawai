# Draft Inisiatif — Pemanfaatan Kawai untuk Layanan AI Internal

Dokumen ini adalah draft pengisian form inisiatif. Isi kolom bersifat deskriptif dan dapat ditelusuri ke kode aplikasi atau situs resmi penyedia; tidak ada klaim penghematan, perbandingan harga, atau angka manfaat yang diperkirakan.

Keterangan kolom **Status**: `Berjalan` = fungsi sudah tersedia dan teruji pada produk; `Usulan` = diusulkan untuk diadopsi; `Perlu verifikasi` = memerlukan bukti atau tinjauan sebelum diajukan.

## 1. Form inisiatif

| # | Directorate | Subdirectorate | Division | Department | IT DPS Department | Initiative | Benefit | Tech Platform | AI Type | Status | Remarks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Teknologi & Digital | Layanan Internal | Arsitektur Solusi | Integrasi Aplikasi | Platform AI | **Integrasi API AI untuk aplikasi internal** — aplikasi internal yang memakai AI diarahkan ke satu penyedia API berformat kompatibel OpenAI/Anthropic | Satu kanal kontrak dan pembayaran untuk pemakaian AI internal; tarif mengikuti daftar harga penyedia; tagihan dalam Rupiah | API kawai.pro (kompatibel OpenAI/Anthropic) | AI Generatif (API) | Usulan | Perubahan terbatas pada konfigurasi alamat dasar dan kunci API; perlu uji coba pada satu aplikasi percontohan |
| 2 | Teknologi & Digital | Kanal Digital | Arsitektur Solusi | Integrasi Aplikasi | Platform AI | **Kanal multimodal melalui API** — kebutuhan gambar, suara, video, pencarian kemiripan (embedding), dan peringkat ulang hasil dilayani dari penyedia yang sama | Kebutuhan teks, gambar, audio, dan video dilayani melalui satu penyedia dan satu kontrak | API kawai.pro (gambar, audio, video, embedding, rerank) | AI Generatif Multimodal | Usulan | Perlu konfirmasi lokasi pemrosesan per model; perlu pembandingan teknis dengan layanan yang sedang berjalan |
| 3 | Teknologi & Digital | Layanan Internal | Layanan Pengguna | Dukungan Pegawai | AI Produktivitas | **Akun AI perusahaan untuk pegawai** — kredit AI terpusat untuk pegawai yang membutuhkan | Pemakaian AI pegawai tercatat dan dapat dibatasi per unit | Aplikasi desktop kawai + kredit terpusat | AI Generatif | Usulan | Perlu penetapan kebijakan penggunaan AI oleh pegawai; pendaftaran dan unduhan melalui https://kawai.pro/ |
| 4 | Teknologi & Digital | Layanan Internal | Layanan Keuangan | Pengendalian Biaya | Billing & Topup | **Tagihan dan pengisian saldo dalam Rupiah** — pemakaian dibayar prabayar per token; pengisian saldo dalam Rupiah tanpa langganan per pengguna | Pemakaian dibayar prabayar per token; tagihan dapat dibatasi per unit; pembayaran dilakukan dalam Rupiah | Topup prabayar kawai (Rupiah) | Tata kelola AI | Perlu verifikasi | Perlu dokumen tarif resmi (Rupiah per satuan token) dan mekanisme pembelian resmi untuk badan usaha |
| 5 | Teknologi & Digital | Layanan Internal | Keamanan Informasi | Perlindungan Data | Keamanan Siber | **Pemrosesan dokumen sensitif di perangkat** — dokumen hukum, pelanggan, dan keuangan diproses tanpa dikirim ke server eksternal | Dokumen tidak meninggalkan perangkat; pemrosesan tetap berjalan tanpa koneksi internet | Model AI terpasang di perangkat | AI Lokal (on-device) | Berjalan — teruji pada Windows, macOS, Linux, Android | Perlu pengujian pada perangkat kerja yang digunakan saat ini |
| 6 | Teknologi & Digital | Data & Analitik | Manajemen Pengetahuan | Pengetahuan Perusahaan | Manajemen Pengetahuan | **Pencarian dokumen internal** — pencarian jawaban dari dokumen internal tanpa mengunggah dokumen | Dokumen internal dapat dicari tanpa proses unggah ke pihak ketiga; pencarian dilakukan pada indeks lokal | Aplikasi desktop, indeks lokal | AI Generatif + Pencarian | Berjalan | Cakupan terbatas pada dokumen yang diindeks |
| 7 | Teknologi & Digital | Layanan Internal | Otomasi Perkantoran | Administrasi Dokumen | Otomasi Perkantoran | **Otomasi dokumen kantor** — pembuatan, pembacaan, pengubahan, dan konversi dokumen Word, Excel, dan PowerPoint | Pekerjaan administrasi dokumen dilakukan pada satu aplikasi; berkas tetap berformat standar sehingga dapat dibuka di aplikasi perkantoran yang ada | Mesin dokumen kantor bawaan (Word, Excel, PowerPoint) | AI Generatif + Otomasi | Berjalan | Pengubahan dilakukan pada berkas yang sudah ada; perlu uji pada templat dokumen internal |
| 8 | Teknologi & Digital | Layanan Internal | Otomasi Perkantoran | Administrasi Dokumen | Otomasi Perkantoran | **Operasi berkas PDF** — pembacaan teks, pencarian, penggantian teks tertentu, penggabungan, pemisahan, dan pemeriksaan struktur | Pekerjaan berkas PDF dilakukan pada satu aplikasi; penggantian teks untuk koreksi terbatas (tanggal, nama, kode) | Mesin PDF bawaan | AI Generatif + Otomasi | Berjalan | Penggantian teks tidak mengubah tata letak; penulisan ulang besar sebaiknya dibuat ulang dari dokumen sumber |
| 9 | Teknologi & Digital | Data & Analitik | Manajemen Pengetahuan | Pengetahuan Perusahaan | Manajemen Pengetahuan | **Pengenalan teks dokumen pindaian (OCR)** — dokumen pindaian dan gambar dibaca menjadi teks yang dapat dicari | Arsip pindaian dapat dicari seperti dokumen digital | Mesin OCR di perangkat | AI Multimodal | Berjalan | Hasil bergantung pada kualitas pindaian |
| 10 | Teknologi & Digital | Kanal Digital | Konten & Komunikasi | Produksi Konten | AI Produktivitas | **Pembuatan materi presentasi** — materi presentasi disusun dari dokumen, data, dan hasil riset | Materi disusun dari dokumen, data, dan hasil riset pada satu alur; hasil dapat diekspor ke PowerPoint | Pembuat dek bawaan (HTML ke PPTX) | AI Generatif | Berjalan | Perlu penyesuaian dengan templat dan identitas visual perusahaan |
| 11 | Teknologi & Digital | Layanan Internal | Otomasi Perkantoran | Administrasi Dokumen | Otomasi Perkantoran | **Penerbitan dokumen hasil kerja otomatis** — hasil analisis atau laporan diterbitkan menjadi berkas PDF atau Word berformat | Hasil kerja diterbitkan menjadi berkas berformat tanpa penyalinan manual | Ekspor dokumen otomatis (PDF/DOCX) | AI Generatif | Berjalan | Format mengikuti templat bawaan; perlu penyesuaian kop dan gaya perusahaan |
| 12 | Teknologi & Digital | Data & Analitik | Manajemen Pengetahuan | Pengetahuan Perusahaan | Manajemen Pengetahuan | **Penyerapan materi video ke basis pengetahuan** — transkrip video, termasuk tautan YouTube, diambil otomatis dan dapat dicari seperti dokumen | Materi rapat dan pelatihan dapat dicari tanpa pencatatan manual | Pengambilan transkrip otomatis | AI Generatif + Pencarian | Berjalan | Bergantung pada ketersediaan transkrip video sumber |
| 13 | Teknologi & Digital | Kanal Digital | Konten & Komunikasi | Produksi Konten | AI Produktivitas | **Pembuatan gambar, video, musik, dan model 3D** — aset visual dan audio dibuat dari deskripsi teks | Kebutuhan aset visual dan audio dibuat melalui satu panel | Panel Generator (gambar, video, musik, model 3D) | AI Generatif Multimodal | Berjalan | Pemakaian menghabiskan saldo token; perlu kebijakan konten dan hak pakai |
| 14 | Teknologi & Digital | Layanan Internal | Layanan Pengguna | Dukungan Pegawai | AI Produktivitas | **Pembacaan teks menjadi suara di perangkat** — naskah dibacakan menjadi audio di perangkat | Naskah dibacakan menjadi audio di perangkat | Mesin suara di perangkat | AI Generatif (audio) | Berjalan | Model suara diunduh sekali saat pertama dipakai (sekitar 191 MB) |
| 15 | Teknologi & Digital | Layanan Internal | Pengembangan Aplikasi | Tim Developer | Pengembangan Aplikasi | **Asisten kode untuk tim developer** — pendampingan penulisan, penelusuran, dan peninjauan kode | Pendampingan penulisan, penelusuran, dan peninjauan kode pada satu kanal; pemakaian dibayar per token | Kawai Code (asisten kode di terminal) | AI Generatif (kode) | Usulan | Perlu kebijakan penggunaan untuk kode internal |
| 16 | Teknologi & Digital | Layanan Internal | Arsitektur Solusi | Integrasi Aplikasi | Integrasi | **Integrasi aplikasi pihak ketiga** — penghubung resmi (OAuth) ke layanan seperti surel, repositori kode, dan catatan | Alur kerja antar aplikasi dijalankan melalui penghubung resmi tanpa berbagi kata sandi | Konektor OAuth | AI Generatif + Integrasi | Usulan | Perlu persetujuan akses dan penilaian risiko data pihak ketiga |
| 17 | Teknologi & Digital | Data & Analitik | Analitik Data | Tim Analis | Analitik | **Analitik data tabular dan koneksi basis data internal** — analisis berkas tabel serta pembacaan data langsung dari basis data internal (PostgreSQL/MySQL) | Analisis berkas tabel dan pembacaan data dilakukan dari satu aplikasi melalui koneksi yang ditentukan | Alat analitik + koneksi basis data | AI Generatif + Analitik | Usulan | Perlu akun baca-saja khusus dan penilaian akses data |
| 18 | Teknologi & Digital | Data & Analitik | Riset Pasar | Analis Pasar | Data Pasar | **Riset pasar saham dan indikator ekonomi** — data harga, laporan keuangan, sentimen pasar, dan indikator makro | Data harga, laporan keuangan, sentimen pasar, dan indikator makro terkumpul dari satu kanal | Alat riset pasar | AI Generatif + Data Pasar | Usulan | Data berasal dari penyedia pihak ketiga; perlu penilaian kesesuaian penggunaan |
| 19 | Teknologi & Digital | Data & Analitik | Riset Pasar | Analis Pasar | Data Pasar | **Pemantauan pasar kripto dan analisis teknikal** — data harga, kedalaman pasar, indikator teknikal, dan penyaring pasar | Pemantauan pasar dijalankan dari satu kanal | Alat pasar kripto | AI Generatif + Data Pasar | Usulan | Perlu tinjauan kepatuhan sebelum dipakai |
| 20 | Teknologi & Digital | Data & Analitik | Riset Pasar | Analis Pasar | Data Pasar | **Audit risiko portofolio berjangka** — pemeriksaan posisi, rasio risiko, dan riwayat transaksi | Risiko portofolio diperiksa berkala dengan catatan yang dapat ditelusuri | Alat audit risiko | AI Generatif + Data Pasar | Usulan | Perlu tinjauan kepatuhan; perintah eksekusi transaksi memerlukan persetujuan manual |
| 21 | Teknologi & Digital | Layanan Internal | Layanan Keuangan | Akuntansi | Akuntansi | **Pembukuan berpasangan dan laporan keuangan** — pencatatan berpasangan, rekonsiliasi, dan laporan keuangan pada basis data lokal | Pencatatan dan rekonsiliasi dilakukan pada basis data lokal; data keuangan tidak keluar dari perangkat | Buku besar lokal (double-entry) | AI Generatif + Akuntansi | Usulan | Perlu penyesuaian bagan akun dan penetapan kebijakan pemakaian sebelum dipakai untuk pembukuan resmi |
| 22 | Teknologi & Digital | Layanan Internal | Layanan Keuangan | Akuntansi | Akuntansi | **Penerbitan faktur dan ekspor pelaporan pajak** — faktur diterbitkan dari buku besar dan laporan disiapkan untuk pelaporan | Faktur diterbitkan dari catatan pembukuan; laporan pajak disusun dari sumber yang sama | Modul faktur dan ekspor pelaporan | AI Generatif + Akuntansi | Perlu verifikasi | Skema pajak bawaan mengikuti GST (India); perlu penyesuaian untuk ketentuan perpajakan yang berlaku di Indonesia |
| 23 | Teknologi & Digital | Data & Analitik | Riset Pasar | Analis Pasar | Data Pasar | **Dompet dan pelaporan aset kripto (baca saja)** — pembacaan saldo, status transaksi, dan riwayat transfer tanpa kemampuan menandatangani transaksi | Pelaporan aset dilakukan tanpa akses tulis | Alat pelaporan rantai (baca saja) | AI Generatif + Data Pasar | Usulan | Hanya baca; perlu tinjauan kepatuhan |
| 24 | Teknologi & Digital | Layanan Internal | Keamanan Informasi | Keamanan Aplikasi | Keamanan Aplikasi | **Pemindaian keamanan aplikasi internal** — pengintaian, pemindaian celah, katalog modul (127 modul), dan pencarian subdomain pada target yang diizinkan | Pemeriksaan keamanan berkala dilakukan secara internal | Pemindai keamanan bawaan | AI + Keamanan | Usulan | Hanya untuk target yang diizinkan tertulis; aplikasi tidak memuat langkah persetujuan otomatis, sehingga persetujuan pemindaian aktif perlu ditetapkan sebagai prosedur internal |
| 25 | Teknologi & Digital | Layanan Internal | Keamanan Informasi | Kepatuhan | Tata kelola AI | **Pemenuhan kebijakan lokasi pemrosesan data untuk layanan AI** — layanan AI internal menggunakan penyedia yang memproses permintaan di pusat data Indonesia | Pemrosesan permintaan AI dilakukan di pusat data Indonesia; mendukung pemenuhan kebijakan lokasi data internal dan ketentuan pelindungan data pribadi | API kawai.pro (pusat data Indonesia) | Tata kelola AI | Perlu verifikasi | Perlu dokumen lokasi pusat data, sertifikasi, dan SLA dari penyedia, serta tinjauan unit hukum/kepatuhan; perlu daftar model yang benar-benar diproses di dalam negeri |
| 26 | Teknologi & Digital | Layanan Internal | Layanan Pengguna | Dukungan Pegawai | AI Produktivitas | **Katalog agen spesialis dan asisten informasi umum** — delapan agen bawaan (dokumen, presentasi, keuangan, analitik, keamanan, dan lain-lain) ditambah bantuan informasi umum | Setiap agen memiliki cakupan tugas masing-masing; pegawai memilih agen sesuai pekerjaan | Aplikasi desktop kawai | AI Generatif | Berjalan | Jumlah agen mengikuti versi aplikasi; perlu penetapan agen yang diizinkan |
| 27 | Teknologi & Digital | Layanan Internal | Otomasi Perkantoran | Otomasi Proses | Otomasi Perkantoran | **Otomasi tugas berulang di perangkat** — menjalankan perintah lokal pada berkas yang dilampirkan serta pembuatan diagram dari data | Pekerjaan teknis berulang dijalankan dari aplikasi yang sama; diagram dibuat dari data yang sama | Perintah lokal terbatas + pembuat diagram | AI Generatif + Otomasi | Usulan | Perlu kebijakan eksekusi perintah dan pembatasan berkas yang dapat diakses |
| 28 | Teknologi & Digital | Layanan Internal | Arsitektur Solusi | Arsitektur Solusi | Platform AI | **Riwayat kerja dan kelanjutan tugas antar sesi** — riwayat percakapan, hasil kerja sebelumnya, dan catatan memori dapat dirujuk kembali | Riwayat percakapan dan hasil kerja sebelumnya dapat dirujuk kembali pada sesi berikutnya | Riwayat lokal per pengguna | AI Generatif | Berjalan | Data tersimpan di perangkat masing-masing pengguna |
| 29 | Teknologi & Digital | Layanan Internal | Layanan Pengguna | Perangkat Pengguna | Platform AI | **Dukungan multiperangkat** — satu basis aplikasi untuk desktop, Android, dan web | Satu basis aplikasi untuk desktop, Android, dan web; pegawai lapangan dapat bekerja tanpa koneksi internet | Desktop, Android, web | Platform AI Perusahaan | Berjalan (desktop dan Android) | Web masih terbatas pada sisi server |
| 30 | Teknologi & Digital | Layanan Internal | Layanan Pengguna | Komunikasi Internal | Komunikasi Internal | **Sosialisasi dan kanal informasi resmi** — pegawai diarahkan ke kanal resmi https://kawai.pro/ untuk informasi dan unduhan | Informasi dan unduhan pegawai diarahkan dari satu daftar kanal resmi | Situs resmi kawai.pro | Tata kelola AI | Usulan | Perlu penetapan daftar kanal resmi; program promosi konsumen (uji coba gratis, kode referral) tidak dipakai untuk akun perusahaan |
| 31 | Teknologi & Digital | Layanan Internal | Keamanan Informasi | Pengelolaan Akses | Keamanan Aplikasi | **Pengelolaan kunci API per aplikasi dan penutupan endpoint administrasi** — kunci API terpisah untuk setiap aplikasi internal, rotasi berkala, dan endpoint administratif (pustaka, penarikan/penghapusan model) tidak dibuka untuk kunci aplikasi | Akses API tercatat per aplikasi dan dapat dicabut tanpa mengganggu aplikasi lain | API kawai.pro (kunci per aplikasi) | Tata kelola AI | Usulan | Perlu prosedur penyimpanan kunci dan pencatatan pemilik kunci; endpoint administratif memerlukan token admin tersendiri |
| 32 | Teknologi & Digital | Layanan Internal | Layanan Keuangan | Pengendalian Biaya | Billing & Topup | **Pemantauan pemakaian token per aplikasi** — laporan jumlah token masukan dan keluaran per permintaan dipakai untuk memantau dan membatasi pemakaian per aplikasi | Pemakaian token per aplikasi dapat ditelusuri dari laporan penyedia | API kawai.pro (laporan pemakaian per permintaan) | Tata kelola AI | Usulan | Batas laju dan kuota resmi belum tercantum di dokumentasi API; perlu konfirmasi tertulis dari penyedia |

---

## 2. Data pembanding tarif

Sumber: daftar harga penyedia (`kawai-website/static/pricing.json`, 220 baris). Angka dipublikasikan penyedia sendiri dan belum diaudit pihak independen; tidak dipakai sebagai dasar penilaian penghematan.

| Kebutuhan | Tarif kawai | Tarif pembanding yang dicantumkan penyedia |
|---|---|---|
| Teks, per 1 juta token | $0,15 | $0,50 |
| Video 10 detik | $0,18 | $1,00 |
| Gambar | $0,09 | $0,15 |

---

## 3. Cakupan API yang tersedia

Alamat dasar `https://api.kawai.pro/v1`; autentikasi memakai kunci API pada header `Authorization: Bearer <kunci>`. Sumber: `kawai-website/docs-source/api/*.md`.

| Kelompok | Endpoint | Keterangan |
|---|---|---|
| Bahasa dan teks | `POST /chat/completions` | Kompatibel OpenAI Chat Completions; mendukung streaming (SSE) dan pemanggilan fungsi (tools) |
| | `POST /messages` | Kompatibel Anthropic Messages |
| | `POST /responses` | Kompatibel OpenAI Responses |
| Pencarian dan kemiripan | `POST /embeddings` | Vektor teks; kompatibel OpenAI Embeddings |
| | `POST /rerank` | Peringkat ulang dokumen terhadap kueri |
| Media | `POST /images/generations`, `/images/edits`, `/images/variations` | Pembuatan, penyuntingan, dan variasi gambar |
| | `POST /audio/speech` | Teks ke suara; kompatibel OpenAI Speech |
| | `POST /audio/transcriptions`, `/audio/translations` | Suara ke teks dan terjemahan audio |
| Katalog dan administrasi | `GET /models`, `/models/{model}`, `/models/ps` | Daftar model, detail model, dan model yang sedang aktif |
| | `GET /catalog`, `/libs` | Katalog model dan informasi pustaka |
| | Penarikan/penghapusan model, unduh pustaka | Tindakan administratif server; memerlukan token admin |

Catatan teknis yang relevan untuk pengajuan:

1. **Pelaporan pemakaian.** Permintaan dapat menyertakan laporan pemakaian token (`include_usage`, aktif secara bawaan) berisi jumlah token masukan, keluaran, dan total, sehingga pemakaian dapat dicatat per aplikasi.
2. **Hak akses per endpoint.** Kunci API memiliki hak akses per endpoint (misalnya kunci hanya untuk `chat-completions`); endpoint administratif memerlukan token admin tersendiri.
3. **Kunci embedding.** Dokumentasi menyebut kunci API berbasis dompet (wallet-based) untuk endpoint embedding; mekanisme ini perlu dijelaskan penyedia untuk pemakaian akun perusahaan.
4. **Model yang dicontohkan dokumentasi.** `qwen3-8b-q8_0` (teks), `qwen2.5-vl-3b-instruct-q8_0` (gambar), `qwen2-audio-7b-q8_0` (audio), `embeddinggemma-300m-qat-Q8_0` (embedding), `bge-reranker-v2-m3-Q8_0` (peringkat ulang), `kokoro` (suara), `whisper` (transkripsi).
5. **Yang belum tercantum di dokumentasi API.** Batas laju, kuota, jaminan tingkat layanan, dan kebijakan retensi data. Semuanya perlu diminta tertulis sebelum diajukan.

---

## 4. Yang perlu dilengkapi sebelum diajukan

1. **Tarif Rupiah resmi.** Rasio 1 token = Rp 0,01 (setara Rp 10.000 per 1 juta token) tercantum pada kode layanan pengisian saldo (`kawai-server/worker/src/qris.ts`, `TOKENS_PER_IDR = 100`; nilai pengisian minimum Rp 10.000), tetapi belum ada dokumen tarif resmi untuk badan usaha. Minta dokumen tarif dan mekanisme pembelian resmi sebelum diajukan.
2. **Daftar model per lokasi pemrosesan.** Pisahkan model yang di-host penyedia di pusat data Indonesia dari model pihak ketiga (antara lain Gemini, Sora, Kling, ElevenLabs, Suno, Flux) yang diproses di infrastruktur penyedia asalnya.
3. **Batas laju, kuota, dan jaminan tingkat layanan.** Belum tercantum di dokumentasi API; minta secara tertulis beserta jalur eskalasi gangguan.
4. **Kebijakan retensi data.** Dokumentasi Responses API menyebut opsi penyimpanan respons di sisi server (`store`, aktif secara bawaan). Untuk pemakaian internal, pastikan opsi tersebut dapat dimatikan atau dapatkan kebijakan retensi tertulis.
5. **Bukti penyedia.** Sertifikasi pusat data, perjanjian tingkat layanan, kebijakan retensi dan penghapusan data.
6. **Pemisahan lingkup.** Pusat data penyedia berbeda dari jaringan komputasi kontributor (jaringan publik berbasis kontribusi perangkat) — nyatakan lingkup mana yang dipakai.
7. **Tinjauan kepatuhan** untuk baris bertema aset kripto (19, 20, 23) dan penggunaan data pasar pihak ketiga (18).
8. **Pengisian kolom Benefit.** Isi dengan deskripsi proses, bukan klaim penghematan, perbandingan harga, atau perkiraan angka; kuantifikasi hanya dari hasil pengukuran uji coba terbatas.
9. **Penyesuaian perpajakan.** Modul faktur bawaan memakai skema GST (India); sesuaikan dengan ketentuan perpajakan Indonesia.
10. **Kebijakan konten dan hak pakai** untuk pembuatan gambar, video, musik, dan model 3D (baris 13).
11. **Struktur organisasi.** Isi kolom Subdirectorate, Division, dan Department sesuai struktur resmi; nilai saat ini masih contoh.

---

## 5. Langkah lanjutan (opsional)

1. Uji coba terbatas: satu aplikasi internal (baris 1), satu alur administrasi dokumen (baris 7), satu tim penyusun materi (baris 10), dan satu tim developer (baris 15), dengan pencatatan pemakaian token per aplikasi (baris 32).
2. Isi kolom Benefit dengan hasil pengukuran uji coba, bukan perkiraan.
3. Ajukan baris berstatus `Berjalan` sebagai bukti kelayakan bila diperlukan.

---

## 6. Referensi resmi

- Situs resmi: https://kawai.pro/
- Aplikasi: https://app.kawai.pro/
- API: https://api.kawai.pro/v1
- Dokumentasi API: https://kawai.pro/docs/api/overview/ (halaman per layanan: `/chat/`, `/messages/`, `/responses/`, `/embeddings/`, `/rerank/`, `/image/`, `/speech/`, `/transcriptions/`, `/tools/`)
- Asisten kode: https://kawai.pro/kawaicode/
- Agen otomasi tugas: https://kawai.pro/kawaiclaw/

---

## 7. Fungsi di luar cakupan form

Tidak diusulkan dalam form ini: token KAWAI dan program mining, marketplace komputasi P2P, program promosi konsumen (uji coba gratis dan kode referral), halaman imbal hasil likuiditas, serta jaringan kontributor komputasi. Alasannya: sasarannya akun pribadi atau jaringan publik, bukan inisiatif internal organisasi.

---

## 8. Sumber fakta

| Bagian | Sumber |
|---|---|
| Daftar fungsi dan status | `kawai/AGENTS.md`; `src-tauri/Cargo.toml` (fitur rilis `release-desktop = litert, tts, binance, accounting, security`) |
| Katalog agen (8 agen) | `src-tauri/src/agent_registry.rs` |
| Fungsi dokumen, PDF, presentasi | `crates/engines/office`; nama tool `office_*` dan `pdf_*` |
| Fungsi analitik, keuangan, kripto, akuntansi, keamanan | `crates/engines`; `crates/toolsets` |
| Endpoint, hak akses, pelaporan pemakaian, opsi `store` | `kawai-website/docs-source/api/` (`overview.md`, `chat.md`, `messages.md`, `responses.md`, `embeddings.md`, `rerank.md`, `image.md`, `speech.md`, `transcriptions.md`, `tools.md`) |
| Tarif dan pembanding | `kawai-website/static/pricing.json` |
| Rasio token Rupiah | `kawai-server/worker/src/qris.ts` (`TOKENS_PER_IDR = 100`, `MIN_BASE = 10_000`) |
| Jumlah modul pemindaian keamanan (127) | `kawai/AGENTS.md`; katalog modul tool `security_modules` (`crates/lonkero`) |
