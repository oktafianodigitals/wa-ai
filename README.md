# WA-AI Auto Reply Bot v2.6.0

WhatsApp Auto Reply AI — Sistem chat otomatis menggunakan Baileys + AI.

## Setup

1. Copy `.env.example` ke `.env` dan isi konfigurasi
2. `nvm install 22`
3. `nvm use 22`
4. `npm install`
5. `npm start`
6. Scan QR code http://localhost:3000/

## Konfigurasi (.env)

| Variable | Default | Deskripsi |
|---|---|---|
| `PORT` | `3000` | Port dashboard WebUI (hanya lewat `.env`, perlu restart) |
| `DB_FILE` | `data.sqlite3` | File database SQLite |
| `TG_SESSION_FILE` | `session.key` | File session WhatsApp |
| `AI_BASE_URL` | `http://localhost:20128/v1/chat/completions` | Endpoint AI chat |
| `AI_API_KEY` | - | API Key untuk AI |
| `AI_MODEL` | `ag/gemini-3.6-flash-medium` | Model AI |
| `AI_BASE_URL_STT` | - | Endpoint Speech-to-Text |
| `AI_MODEL_STT` | `whisper-1` | Model STT |
| `MAX_HISTORY` | `70` | Jumlah pesan riwayat |
| `DEBOUNCE_MS` | `8000` | Delay debounce (ms) |
| `EXTRA_PROMPT` | - | Prompt tambahan untuk AI |
| `AI_SYSTEM_PROMPT` | - | System prompt utama |
| `AI_VOICE_SELECT_PROMPT` | - | Prompt pemilih voice note |
| `MAX_FILE_MB` | `50` | Lampiran lebih besar tidak diunduh (pelanggan tetap dibalas) |
| `AI_VISION_ENABLED` | `false` | Kirim gambar ke AI (model harus mendukung gambar) |
| `AUTO_CATEGORIZE_ENABLED` | `true` | AI memasukkan customer ke kategori otomatis |
| `CATEGORY_MIN_CONFIDENCE` | `60` | Keyakinan minimum AI (0-100) untuk menetapkan/memindahkan kategori |
| `CATEGORY_PROMPT` | - | Instruksi tambahan untuk pengklasifikasi |
| `WA_LABEL_SYNC_ENABLED` | `true` | Kategori = Label WhatsApp Business (dua arah) |

## API Endpoints

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Status koneksi WhatsApp |
| GET | `/api/history/:jid` | Riwayat chat per JID |
| GET | `/api/media/:id` | Unduh/tampilkan lampiran pesan |
| GET | `/api/categories` | Daftar kategori (label WhatsApp) + status sinkron |
| POST | `/api/categories/sync` | Ambil ulang label & pemasangannya dari WhatsApp |
| PUT/DELETE | `/api/categories/:id` | Ubah kriteria AI / hapus kategori lokal (label WhatsApp dihapus di WhatsApp) |
| POST | `/api/categories/classify-all` | AI mengelompokkan ulang semua chat (latar belakang) |
| PUT | `/api/chats/:jid/category` | Tetapkan kategori manual (`category_id: null` = kembali ke otomatis) |
| POST | `/api/chats/:jid/categorize` | Minta AI menentukan kategori chat sekarang |
| PUT | `/api/chats/:jid/bot` | Aktif/matikan balas otomatis untuk satu chat |
| GET | `/api/voice-files` | List file voice note |
| GET | `/api/db/stats` | Statistik database |
| GET | `/api/settings` | Ambil semua pengaturan (.env) |
| POST | `/api/settings` | Ubah pengaturan (.env) langsung dari dashboard |
| POST | `/api/send` | Kirim pesan manual |
| POST | `/api/logout` | Logout — hapus sesi & database |

## Settings Dashboard

Semua variabel `.env` bisa diubah langsung dari halaman WebUI **Settings** (tanpa edit file manual):
AI Base URL/Model/API Key, STT, `MAX_HISTORY`, `DEBOUNCE_MS`, prompt-prompt, `DB_FILE`,
dan `TG_SESSION_FILE`. `PORT` kini diatur hanya lewat file `.env`. Perubahan AI aktif otomatis;
`DB_FILE` / `TG_SESSION_FILE` baru aktif setelah restart. API key ditampilkan termask (disembunyikan).

## Lampiran (semua jenis file)

Bot tidak lagi "bengong" saat menerima lampiran. Semua pesan non-teks disimpan dan dibalas AI:

| Jenis | Yang terjadi |
|---|---|
| Dokumen apa pun (PDF, Word, Excel, ZIP, dst), gambar, video, audio, stiker | Diunduh ke folder `uploads/`, tampil di dashboard (pratinjau / kartu unduhan), AI membalas |
| File teks (txt, csv, json, md, log, dll) | Isinya (maks 3000 karakter) ikut dibaca AI |
| Gambar | Dikirim ke AI bila `AI_VISION_ENABLED=true`; bila model menolak, otomatis diulang tanpa gambar |
| Voice note / audio | Ditranskripsi (STT) bila dikonfigurasi; bila tidak, tetap dibalas |
| Kontak, lokasi, polling, balasan tombol/daftar, jenis lain | Diubah menjadi teks (mis. `[Lokasi] ...`) lalu dibalas |
| File lebih besar dari `MAX_FILE_MB` / unduhan gagal | Tidak disimpan, tetapi pelanggan tetap dibalas dan AI diminta meminta kirim ulang |

Catatan: isi PDF, Word, dan video belum diekstrak; AI mengakui penerimaan file dan menanyakan kebutuhan pelanggan,
tanpa berpura-pura membaca isinya. File selain gambar/audio/video selalu diunduh (tidak dirender di browser) demi keamanan.

## Kategori customer (grouping)

1. Buat **Label** di aplikasi **WhatsApp Business** (Alat bisnis → Label), mis. *Payment*. Bot membacanya otomatis sebagai kategori;
   menu **Kategori** menampilkannya (klik *Sinkronkan label WhatsApp* untuk menarik ulang). Isi **kriteria** bila perlu.
2. Setiap pelanggan mengirim pesan, AI membaca percakapan, memilih **satu** label yang tepat, lalu **memasangnya ke chat di WhatsApp**
   (label kategori sebelumnya dilepas). Contoh: pelanggan mengirim bukti transfer → label *Payment*.
   Berjalan terpisah dari balasan, tetap aktif walau balas otomatis dimatikan.
3. Di halaman **Chat**: lencana kategori di daftar, filter per kategori, dan pemilih kategori di tiap percakapan (ikut memasang label di WhatsApp).
4. Label yang dipasang/dilepas manual di aplikasi WhatsApp ikut tercermin di dashboard. Kategori yang ditetapkan **manual dari dashboard**
   tidak diubah AI; pilih *Belum ada / otomatis* untuk menyerahkannya kembali, atau *Tentukan dengan AI* untuk penilaian saat itu juga.
5. Label baru dibuat setelah ada chat? Klik *Kelompokkan semua chat*.

AI hanya memindahkan kategori bila keyakinannya ≥ `CATEGORY_MIN_CONFIDENCE`, dan menolak nama kategori yang tidak ada di daftar (tidak pernah membuat label baru).
Setiap pesan memakai satu panggilan AI tambahan; matikan lewat `AUTO_CATEGORIZE_ENABLED=false` bila tidak diperlukan.

## Voice Notes

Taruh file audio (.mp3/.ogg/.wav/.m4a/.opus) di folder `voice-notes/`. Bot akan memilih secara otomatis menggunakan AI.

## Arsitektur

```
public/               # WebUI (dashboard)
├── index.html
├── css/style.css
└── js/app.js
src/
├── index.js          # Entry point
├── config.js         # Konfigurasi .env (hot-reload)
├── settings.js       # Baca/tulis .env dari dashboard
├── baileys.js        # Koneksi WhatsApp
├── ai.js             # AI chat completions
├── stt.js            # Speech-to-text
├── media.js          # Pengenalan jenis pesan, unduh & simpan lampiran
├── categories.js     # Klasifikasi customer ke kategori (label) oleh AI
├── labels.js         # Sinkron Label WhatsApp <-> kategori
├── voice-select.js   # Pemilih file voice note
├── debounce.js       # Debounce handler
├── db.js             # SQLite database
└── router.js         # HTTP API router
```

## Troubleshooting 9router

Log lama hanya menampilkan `request to ... failed, reason:` (kosong) karena Node 20+ memberi error koneksi tanpa pesan.
Sekarang kode error asli ditampilkan, mis. `Koneksi ditolak (ECONNREFUSED) ke 127.0.0.1:20128`.

1. Pastikan 9router berjalan, lalu buka `http://localhost:20128` di browser.
2. Dashboard → **Pengaturan → Koneksi AI → Tes koneksi** menjalankan diagnosa bertahap (alamat, server, API key, model, percakapan).
3. Bila 9router meminta API key, buat di dashboard 9router (Endpoint → API Keys) dan isi di Pengaturan.
4. Nama model harus ada di 9router. Klik **Ambil daftar model** untuk memilih.
5. AI Base URL boleh `http://localhost:20128`, `.../v1`, atau `.../v1/chat/completions`.

## 📈 Riwayat Update

### v2.8.1
- **Prompt disimpan di database** (tabel `app_settings`): `AI_SYSTEM_PROMPT`, `EXTRA_PROMPT`, `AI_VOICE_SELECT_PROMPT`, `CATEGORY_PROMPT`
  - Dashboard menyimpan dan memuat prompt dari SQLite, sehingga teks multi-baris (pemisah `\n\n`) utuh dan tidak lagi terpotong di baris pertama seperti di `.env`
  - Database menang atas `.env`. Nilai prompt di `.env` hanya data awal: disalin sekali ke database saat pertama jalan (literal `\n` diubah jadi baris baru), setelah itu diabaikan
  - Pengaturan non-prompt tetap di `.env`

### v2.8.0
- **Balas otomatis per chat**: setiap percakapan punya saklar sendiri di header chat; daftar chat menampilkan penanda **BOT** (sedang dibalas bot) atau **MANUAL** (bot tidak membalas, karena dimatikan untuk chat itu atau saklar global mati)
  - Saklar global tetap berlaku sebagai induk; kategorisasi tetap berjalan walau bot dimatikan untuk chat tersebut
  - Tabel baru `chat_bot`; endpoint baru: `PUT /api/chats/:jid/bot` (`{"enabled": true|false}`)
- **Sinkron label lebih mudah didiagnosis**: sinkron diulang otomatis (5 dtk, 45 dtk, 2,5 mnt setelah terhubung) bila belum ada label; dashboard menampilkan penyebab bila WhatsApp tidak mengirim data label, dan log `[WA-SYNC]` mencatat kegagalan
  - Perbaikan: kunci sinkronisasi app-state sekarang dibaca sebagai protobuf (seperti penyimpanan bawaan Baileys)

### v2.7.0
- **Kategori = Label WhatsApp (WhatsApp Business)**: bot membaca label yang sudah kamu buat di WhatsApp, tidak membuat kategori baru
  - Label (nama, warna) tersinkron otomatis saat terhubung dan setiap ada perubahan; tombol **Sinkronkan label WhatsApp** di menu Kategori untuk menarik ulang
  - Setelah percakapan, AI memilih label yang tepat dan **memasangnya ke chat di WhatsApp** (label kategori sebelumnya dilepas). Contoh: pelanggan mengirim bukti/konfirmasi transfer → label pembayaran
  - Dua arah: label yang dipasang/dilepas manual di aplikasi WhatsApp ikut tercermin di dashboard
  - Kriteria untuk AI tetap bisa diisi per label (label bawaan WhatsApp Business sudah punya kriteria awal); nama & warna mengikuti WhatsApp
  - Kategori lokal dari v2.6.0 dengan nama yang sama dengan label otomatis diadopsi (kriteria & penetapan chat dipertahankan); tombol tambah kategori dan kategori contoh dihapus
  - Pengaturan baru: `WA_LABEL_SYNC_ENABLED`. Logout ikut menghapus label tersinkron
  - Catatan: butuh akun **WhatsApp Business**. Bila label tidak terbaca, keluar lalu scan QR ulang

### v2.6.0
- **Terima semua jenis file**: dokumen apa pun, gambar (termasuk tanpa caption), video, audio, stiker, kontak, lokasi, polling, dan jenis lain kini disimpan dan dibalas AI
  - Perbaikan: sebelumnya gambar tanpa caption dan semua dokumen diabaikan diam-diam sehingga bot tidak membalas
  - Lampiran disimpan di `uploads/` (batas `MAX_FILE_MB`, ditegakkan juga saat streaming), tampil di dashboard; isi file teks dibaca AI; opsi vision untuk gambar
  - Pesan teknis (reaksi, edit, grup) tetap diabaikan; status@broadcast kini tidak lagi dibalas
  - Endpoint baru: `GET /api/media/:id`
- **Kategori customer**: menu Kategori (tambah/ubah/hapus, warna, kriteria untuk AI), AI memasukkan customer ke kategori berdasarkan percakapan,
  filter + lencana di daftar chat, penetapan manual (dikunci dari AI), "Tentukan dengan AI", dan "Kelompokkan semua chat"
  - Tabel baru `categories`, `chat_categories`; kolom lampiran baru di `messages` (DB lama dimigrasi otomatis)
  - Pengaturan baru: `MAX_FILE_MB`, `AI_VISION_ENABLED`, `AUTO_CATEGORIZE_ENABLED`, `CATEGORY_MIN_CONFIDENCE`, `CATEGORY_PROMPT`
- Membersihkan chat juga menghapus lampirannya dari disk; logout membersihkan seluruh `uploads/`

### v2.5.3
- **Bersihkan percakapan**: tombol hapus di setiap baris chat (muncul saat disorot) dan tombol "Bersihkan chat" di header percakapan, dengan konfirmasi
  - Menghapus riwayat satu chat dari database sehingga konteks AI mulai dari nol; balasan AI yang masih menunggu untuk chat itu dibatalkan
  - Endpoint baru: `DELETE /api/chats/:jid`

### v2.5.2
- **Chat menampilkan identitas kontak**: nama (nama profil WhatsApp), nomor, dan foto profil; bila tidak ada foto tampil inisial
  - Tabel baru `contacts` di database; foto di-cache ke folder `avatars/` dan diperbarui tiap 24 jam
  - Kontak berformat `@lid` tidak membawa nomor telepon (WhatsApp menyembunyikannya), jadi hanya nama yang tampil
  - Endpoint baru: `GET /api/avatar/:jid`, `POST /api/contacts/refresh`
  - Username WhatsApp belum tersedia lewat Baileys 6.x

### v2.5.1
- `PORT` dipindah ke `.env` (tidak lagi ada di form Pengaturan dashboard); ditambahkan ke `.env.example`

### v2.5.0
- **Fix koneksi AI / 9router**: modul baru `ai-client.js` dipakai chat, pemilih voice note, dan diagnosa
  - Menggali kode error asli (ECONNREFUSED, ETIMEDOUT, ...) beserta saran perbaikan
  - `localhost` dicoba sebagai `127.0.0.1`, `localhost`, lalu `[::1]` (masalah IPv4/IPv6 di Windows); host yang berhasil diingat
  - Base URL dinormalisasi otomatis; timeout kini juga mencakup pembacaan stream
  - Endpoint baru: `POST /api/ai/test`, `GET|POST /api/ai/models`; `GET /api/ai/status` kini mengecek 9router langsung
  - Pesan terbaru tidak lagi dikirim dua kali ke AI
- **UI/UX baru**: dashboard dengan jalur koneksi WhatsApp → Auto reply → 9router → Model, grafik 7 hari, chat gaya WhatsApp
  (gelembung, pemisah hari, balas manual, tampilan ponsel), voice note (unggah, putar, hapus, cari), pengaturan terkelompok dengan tombol tes koneksi
- Perbaikan: halaman Chat sebelumnya rusak karena HTML dan JS tidak sinkron; pesan manual kini tersimpan di riwayat; mimetype voice note sesuai ekstensi
- Endpoint baru: `GET /api/recent`, `GET /api/voice-files/:name/audio`, `POST /api/voice-files?name=`, `DELETE /api/voice-files/:name`

### v2.4.0 (2026-09-02)
- **Settings Dashboard** — semua variabel `.env` kini dapat dibaca & diubah langsung dari WebUI
  - Endpoint baru: `GET/POST /api/settings`
  - `config.js` di-refactor jadi runtime (hot-reload): perubahan AI aktif tanpa restart
  - API key ditampilkan termask (masked) di UI
  - Modul konsumen (`ai`, `stt`, `voice-select`, `debounce`, `db`, `baileys`, `index`) membaca `config` saat runtime

### v2.3.2 (2026-09-02)
- **Fix kritis: QR tidak pernah tampil / loop `Connection closed`**
  - `single-file-auth` mengembalikan format salah (array) untuk `keys.get` → Baileys menganggap store sesi kosong → gagal handshake; diperbaiki: `keys.get` kembalikan object `{ [id]: value }` + `async`
  - **Fix kedua**: `creds` kosong (`{}`) menyebabkan `Cannot read properties of undefined (reading 'public')`. Kini diinisialisasi dengan `initAuthCreds()` (persis `useMultiFileAuthState` resmi) + serialisasi `BufferJSON`
  - Tambah method `keys.clear`
- Log koneksi kini menampilkan detail error (pesan asli)

### v2.3.1 (2026-09-02)
- Fix: QR basi/stale tidak lagi tampil — cache QR di-reset setiap siklus pairing baru
- Fix: teks status "Menghubungkan ke server" hanya muncul saat socket putus; "Menunggu QR code..." saat terkoneksi tapi QR belum tiba
- `qr-request` selalu membalas (termasuk null) agar client membersihkan QR lama
- QR direquest ulang otomatis tiap 5 detik jika belum muncul

### v2.3.0 (2026-09-02)
- **Halaman login QR fullscreen** sebelum dashboard
  - Sebelum login: hanya tampil layar QR untuk scan
  - Setelah terhubung: dashboard lengkap muncul otomatis
  - Indikator loading QR saat menunggu

### v2.2.0 (2026-09-02)
- **Logout button** di WebUI — bersihkan sesi login (session.key) + semua data database
- Fix: QR code tidak muncul — 
  - QR ter-cache di server & dikirim ulang ke client baru / saat reconnect (socket)
  - Guard anti double-socket + reconnect delay (3 detik) — mencegah QR flapping
- Endpoint baru: `POST /api/logout`
- Tambah `.gitignore` (node_modules, .env, session.key, data.sqlite3, voice-notes, backup)

### v2.1.2 (2026-09-02)
- Sesi login sekarang disimpan dalam **1 file `session.key`** (sesuai `TG_SESSION_FILE`)
- Migrasi dari multi-file folder `session/` ke single-file `session.key`
- Semua data tetap di **1 database `data.sqlite3`**

### v2.1.1 (2026-09-02)
- Fix: AI API retry & timeout untuk kegagalan koneksi
- Fix: dukungan respons streaming (SSE `data:` chunks) dari AI endpoint
- Tambah retry mechanism (maks 3x)

### v2.1.0 (2026-09-02)
- QR code tampil di WebUI secara real-time (WebSocket socket.io)
- Daftar semua chat tampil di WebUI (klik untuk lihat riwayat)
- Endpoint baru: `GET /api/chats`

### v2.0.0 (2026-09-02)
- Tambah WebUI dashboard (public/)
  - Status koneksi WhatsApp real-time
  - Statistik database (total pesan & chat)
  - Kirim pesan manual
  - Lihat riwayat chat per JID
  - List file voice notes
- Serve static file via Express

### v1.0.0 (2026-09-02)
- Inisialisasi project
- Koneksi WhatsApp via Baileys
- AI chat auto-reply dengan riwayat (SQLite)
- Voice note transcription (STT)
- Auto-select & kirim voice note via AI
- Debounce system (8 detik default)
- HTTP API (Express) untuk monitoring & kontrol
