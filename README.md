# WA-AI Auto Reply Bot v2.5.0

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

## API Endpoints

| Method | Endpoint | Deskripsi |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Status koneksi WhatsApp |
| GET | `/api/history/:jid` | Riwayat chat per JID |
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
