# Guide — WA-AI Auto Reply Bot v2.4.0

## Arsitektur

```
src/
├── index.js          # Entry point, Express server
├── config.js         # Load .env ke config runtime (hot-reload)
├── settings.js       # Baca/tulis .env dari dashboard WebUI
├── baileys.js        # Koneksi WhatsApp via Baileys, handle pesan masuk
├── ai.js             # Kirim chat ke AI API, bangun riwayat
├── stt.js            # Transkripsi voice note → teks
├── voice-select.js   # Pilih file voice note dari folder voice-notes/
├── debounce.js       # Tunda balasan (8 detik default)
├── db.js             # SQLite — simpan & ambil riwayat chat
└── router.js         # HTTP API Express
```

## Alur Kerja

1. **Pesan masuk** → `baileys.js` terima, parse teks/voice
2. **Voice note** → `stt.js` transkripsi via AI STT API
3. **Simpan** → `db.js` simpan ke SQLite
4. **Debounce** → `debounce.js` tunda 8 detik (reset kalau user kirim lagi)
5. **AI Chat** → `ai.js` kirim ke AI API dengan riwayat 70 pesan terakhir
6. **Balas teks** → kirim jawaban AI ke WhatsApp
7. **Voice reply** → `voice-select.js` pilih file audio dari `voice-notes/`, kirim sebagai voice note

## File Penting

| File | Fungsi |
|---|---|
| `.env` | Semua konfigurasi (lihat `.env.example`) |
| `session.key` | File sesi WhatsApp (dari `TG_SESSION_FILE`, jangan dihapus) |
| `data.sqlite3` | Database riwayat chat |
| `voice-notes/` | File audio untuk balasan voice note |
| `backup/` | Backup zip per versi |

## Error Codes

| Error | Penyebab | Solusi |
|---|---|---|
| `AI API error 401` | API key salah/tidak ada | Cek `AI_API_KEY` di `.env` |
| `AI API error 403` | API key tidak punya akses | Cek permission di provider AI |
| `AI API error 429` | Rate limit terlampaui | Tunggu, atau kecilkan MAX_HISTORY |
| `AI API error 503` | AI server down | Cek `AI_BASE_URL` |
| `request to ... failed` | AI server mati / offline | Pastikan AI server aktif di `AI_BASE_URL` |
| `STT API error` | STT server down | Cek `AI_BASE_URL_STT` |
| `Connection closed 401` | WhatsApp logged out | Hapus `session.key`, scan QR ulang |

## API Reference

### GET /api/health
```json
{ "status": "ok", "timestamp": 1234567890 }
```

### GET /api/status
```json
{ "connected": true, "user": { "id": "...", "name": "..." } }
```

### GET /api/history/:jid?limit=50
```json
{ "jid": "...", "messages": [{"sender":"...","content":"...","is_from_bot":0}] }
```

### GET /api/voice-files
```json
{ "files": ["halo.mp3", "sapaan-pagi.ogg"] }
```

### GET /api/db/stats
```json
{ "totalMessages": 1234, "totalChats": 56 }
```

### POST /api/send
Body: `{ "jid": "12345@s.whatsapp.net", "text": "Halo!" }`
```json
{ "ok": true, "jid": "...", "text": "..." }
```

### POST /api/logout
Membersihkan sesi login (`session.key`) dan seluruh isi database, lalu memulai ulang koneksi untuk menampilkan QR baru.
```json
{ "ok": true, "message": "Sesi dan database dibersihkan. Silakan scan QR baru." }
```

### GET /api/settings
Mengembalikan semua nilai `.env` (API key termask).
```json
{
  "DB_FILE": "data.sqlite3",
  "TG_SESSION_FILE": "session.key",
  "AI_BASE_URL": "http://localhost:20128/v1/chat/completions",
  "AI_API_KEY_MASKED": "agx***xyz",
  "HAS_API_KEY": true,
  "MAX_HISTORY": "70",
  "DEBOUNCE_MS": "8000",
  "PORT": "3000"
}
```

### POST /api/settings
Body: `{ "AI_MODEL": "gpt-4o", "MAX_HISTORY": "100", ... }` (key boleh sebagian).
Menulis ke `.env` + hot-reload config. Kirim `AI_API_KEY` kosong → key tidak berubah.
```json
{ "ok": true, "updated": ["AI_MODEL", "MAX_HISTORY"], "note": "..." }
```

## Settings Dashboard

- Semua variabel `.env` dapat diubah dari WebUI → kartu **Settings** (tanpa edit file manual)
- Perubahan nilai AI langsung aktif (hot-reload via `config`)
- `DB_FILE`, `TG_SESSION_FILE`, `PORT` baru aktif setelah **restart server**
- Cara kerja: `settings.js` menulis `.env` → `applyEnvOverrides` update `process.env` → `refreshConfig()` reload `config`

## Riwayat Update

### v2.4.0 (2026-09-02)
- **Settings Dashboard**: semua variabel `.env` bisa dibaca & diubah dari WebUI
  - Endpoint: `GET /api/settings`, `POST /api/settings`
  - `config.js` di-refactor → objek `config` mutable + `refreshConfig()` (hot-reload)
  - Modul baru `src/settings.js` — mask API key, tulis `.env`, escape newline multi-baris
  - Semua konsumen config (`ai.js`, `stt.js`, `voice-select.js`, `debounce.js`, `db.js`, `baileys.js`, `index.js`) kini membaca `config.*` saat runtime
- **Fix QR (kelanjutan v2.3.2)**: `single-file-auth.js` kini menginisialisasi `creds` dengan `initAuthCreds()` bila fresh (noiseKey/signedIdentityKey/registrationId) + serialisasi `BufferJSON` — persis perilaku `useMultiFileAuthState` resmi → QR berhasil muncul

### v2.3.2 (2026-09-02)
- **Fix kritis QR tidak muncul (loop `Connection closed. Status: undefined`)**
  - Akar masalah: `src/single-file-auth.js` — `keys.get` mengembalikan **array**, padahal Baileys v6 `SignalKeyStore.get` mengharuskan **object** `{ [id]: value }`
  - Akibat: store sesi selalu dianggap kosong → noise handshake gagal → socket langsung close tanpa pernah generate QR
  - Perbaikan: `get` → `async` dan return object; tambah `keys.clear()`
  - Fix lanjutan: `creds` fresh diinisialisasi `initAuthCreds()` (mencegah `Cannot read properties of undefined (reading 'public')`) + `BufferJSON` untuk serialisasi buffer yang benar
- Log `[WA] Connection closed` kini menyertakan pesan error asli untuk diagnosa

### v2.3.1 (2026-09-02)
- Fix QR stale:
  - Cache QR (`latestQr`) di-reset setiap `startWA()` baru → QR lama tidak tampil di login screen
  - `qr-request` selalu merespons (termasuk `null`) → client membersihkan QR lama & tampil loading
- Fix teks status login:
  - Socket putus → "Menghubungkan ke server..."
  - Socket terkoneksi tapi belum ada QR → "Menunggu QR code..."
  - QR tiba → teks hilang, QR tampil
- Auto re-request QR setiap 5 detik saat menunggu

### v2.3.0 (2026-09-02)
- WebUI: layar **login QR fullscreen** muncul sebelum dashboard
  - Belum login → hanya layar QR besar (loading state saat menunggu)
  - Terhubung → dashboard otomatis tampil
  - Logout / terputus → kembali ke layar QR
- Layout: `login-screen` terpisah dari `dashboard`

### v2.2.0 (2026-09-02)
- Tombol **Logout** di WebUI — membersihkan sesi (`session.key` + auth state) dan seluruh isi `data.sqlite3`, lalu otomatis scan QR baru
- Perbaikan QR code:
  - QR di-cache di server (`socket.js`) dan dikirim ke client yang baru terhubung (event `qr-request`)
  - Anti hot-loop reconnect (guard `connecting` + delay 3 detik) agar QR tidak bergantian
- Endpoint baru: `POST /api/logout`
- Tambah `.gitignore` untuk melindungi file sensitif
  
### v2.1.2 (2026-09-02)
- Sesi login disimpan dalam **satu file `session.key`** (mengikuti `TG_SESSION_FILE`)
- Modul baru `src/single-file-auth.js` — adapter auth state single-file (base64 buffer, round-trip aman)
- Migrasi otomatis data folder `session/` → `session.key`
- Semua data tersimpan dalam satu database `data.sqlite3`

### v2.1.1 (2026-09-02)
- Fix: AI API gagal karena koneksi terputus → tambah retry (3x) + backoff
- Fix: endpoint AI mengembalikan stream (`data: {...}`) → parsing SSE didukung
  - Menghandle `text/event-stream` & `application/x-ndjson`
  - Menggabungkan `delta.content` dari setiap chunk
- Fraksi error `401 Missing API key` dihindari dengan berhenti saat 401/403/429

### v2.1.0 (2026-09-02)
- QR code tampil di WebUI real-time via WebSocket (socket.io)
- Daftar semua chat tampil di WebUI (klik item untuk lihat riwayat)
- Endpoint baru: `GET /api/chats`
- Modul baru: `src/socket.js`

### v2.0.0 (2026-09-02)
- Tambah WebUI dashboard (`public/`)
  - Status koneksi WhatsApp (auto-refresh 5 detik)
  - Statistik database
  - Kirim pesan manual via UI
  - Lihat riwayat chat per JID
  - List file voice notes
- Serve static file Express (`index.js`)

### v1.0.0 (2026-09-02)
- Inisialisasi project dari nol
- Baileys WhatsApp connection + auto-reconnect
- SQLite riwayat chat (70 pesan)
- AI chat completions dengan system prompt
- Voice note transcription (STT)
- Auto-select & kirim voice note via AI
- Debounce system (8 detik)
- Express HTTP API (6 endpoints)
- Backup & versioning system
