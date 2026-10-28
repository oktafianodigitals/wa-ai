import Database from 'better-sqlite3';
import { config } from './config.js';

let db;

export function initDB() {
  db = new Database(config.DB_FILE);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      is_from_bot INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, timestamp);
    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      pic_checked INTEGER DEFAULT 0,
      pic_ok INTEGER DEFAULT 0,
      pic_version INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '#2f6f9f',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_categories (
      chat_jid TEXT PRIMARY KEY,
      category_id INTEGER NOT NULL,
      assigned_by TEXT NOT NULL DEFAULT 'ai',
      confidence REAL,
      reason TEXT DEFAULT '',
      updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_categories_cat ON chat_categories(category_id);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_bot (
      chat_jid TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated INTEGER NOT NULL
    );
  `);

  // Migrasi ringan: kolom lampiran pada tabel messages (DB lama tetap kompatibel).
  const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
  const addCols = {
    media_type: 'TEXT',   // image | video | audio | document | sticker | contact | location | other
    media_name: 'TEXT',
    media_mime: 'TEXT',
    media_size: 'INTEGER',
    media_path: 'TEXT',   // nama file di folder uploads/ (kosong bila tidak diunduh)
    media_text: 'TEXT',   // isi teks hasil ekstraksi (file teks) untuk konteks AI
  };
  for (const [name, type] of Object.entries(addCols)) {
    if (!cols.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
  }

  // Migrasi: kategori kini disinkronkan dari Label WhatsApp (Business).
  const catCols = new Set(db.prepare('PRAGMA table_info(categories)').all().map(c => c.name));
  if (!catCols.has('wa_label_id')) db.exec('ALTER TABLE categories ADD COLUMN wa_label_id TEXT');
  if (!catCols.has('wa_predefined')) db.exec('ALTER TABLE categories ADD COLUMN wa_predefined TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_wa_label ON categories(wa_label_id) WHERE wa_label_id IS NOT NULL');

  console.log(`[DB] SQLite connected: ${config.DB_FILE}`);
  return db;
}

export function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

/** Simpan pesan. `media` opsional: { type, name, mime, size, path, text }. Mengembalikan id baris. */
export function saveMessage(chatJid, sender, content, isFromBot = false, media = null) {
  const stmt = getDB().prepare(
    `INSERT INTO messages
       (chat_jid, sender, content, is_from_bot, timestamp,
        media_type, media_name, media_mime, media_size, media_path, media_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const r = stmt.run(
    chatJid, sender, content, isFromBot ? 1 : 0, Date.now(),
    media?.type ?? null, media?.name ?? null, media?.mime ?? null,
    media?.size ?? null, media?.path ?? null, media?.text ?? null,
  );
  return Number(r.lastInsertRowid);
}

export function getMessage(id) {
  return getDB().prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
}

export function getHistory(chatJid, maxHistory = 70) {
  const stmt = getDB().prepare(
    `SELECT id, sender, content, is_from_bot, timestamp,
            media_type, media_name, media_mime, media_size, media_path, media_text
     FROM messages
     WHERE chat_jid = ?
     ORDER BY timestamp DESC
     LIMIT ?`
  );
  const rows = stmt.all(chatJid, maxHistory);
  return rows.reverse();
}

const MAX_FILE_TEXT_FOR_AI = 3000;

export function formatHistoryForAI(history) {
  return history.map(msg => {
    let content = msg.content;
    if (!msg.is_from_bot && msg.media_text) {
      content += `\n[Isi file "${msg.media_name || 'lampiran'}"]\n${String(msg.media_text).slice(0, MAX_FILE_TEXT_FOR_AI)}`;
    }
    return { role: msg.is_from_bot ? 'assistant' : 'user', content };
  });
}

export function listChats() {
  const stmt = getDB().prepare(`
    SELECT m.chat_jid,
           COUNT(*) as total_messages,
           MAX(m.timestamp) as last_time,
           (
             SELECT content FROM messages m2
             WHERE m2.chat_jid = m.chat_jid
             ORDER BY m2.timestamp DESC, m2.id DESC LIMIT 1
           ) as last_message,
           c.name as contact_name, c.phone as contact_phone,
           c.pic_ok as pic_ok, c.pic_version as pic_version,
           COALESCE(cb.enabled, 1) as bot_enabled,
           cc.category_id as category_id, cc.assigned_by as category_by,
           cat.name as category_name, cat.color as category_color
    FROM messages m
    LEFT JOIN contacts c ON c.jid = m.chat_jid
    LEFT JOIN chat_bot cb ON cb.chat_jid = m.chat_jid
    LEFT JOIN chat_categories cc ON cc.chat_jid = m.chat_jid
    LEFT JOIN categories cat ON cat.id = cc.category_id
    GROUP BY m.chat_jid
    ORDER BY last_time DESC
  `);
  return stmt.all();
}

/* ---------- Kontak (nama, nomor, foto profil) ---------- */

export function getContact(jid) {
  return getDB().prepare('SELECT * FROM contacts WHERE jid = ?').get(jid) || null;
}

export function upsertContact(jid, { name, phone } = {}) {
  if (!jid) return;
  const db = getDB();
  const cur = getContact(jid);
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 120) : '';
  const cleanPhone = typeof phone === 'string' ? phone.replace(/\D/g, '').slice(0, 20) : '';
  if (!cur) {
    db.prepare('INSERT INTO contacts (jid, name, phone, updated) VALUES (?, ?, ?, ?)')
      .run(jid, cleanName || null, cleanPhone || null, Date.now());
    return;
  }
  const nextName = cleanName || cur.name;
  const nextPhone = cleanPhone || cur.phone;
  if (nextName !== cur.name || nextPhone !== cur.phone) {
    db.prepare('UPDATE contacts SET name = ?, phone = ?, updated = ? WHERE jid = ?')
      .run(nextName, nextPhone, Date.now(), jid);
  }
}

export function setContactPicture(jid, ok, version = Date.now()) {
  upsertContact(jid);
  getDB().prepare('UPDATE contacts SET pic_checked = ?, pic_ok = ?, pic_version = ? WHERE jid = ?')
    .run(Date.now(), ok ? 1 : 0, ok ? version : (getContact(jid)?.pic_version || 0), jid);
}

export function listChatJids() {
  return getDB().prepare('SELECT DISTINCT chat_jid FROM messages').all().map(r => r.chat_jid);
}
/** Daftar file lampiran sebuah chat (untuk dihapus dari disk saat chat dibersihkan). */
export function listChatMediaPaths(chatJid) {
  return getDB().prepare('SELECT media_path FROM messages WHERE chat_jid = ? AND media_path IS NOT NULL')
    .all(chatJid).map(r => r.media_path);
}

export function clearChat(chatJid) {
  // Kategori yang ditetapkan AI ikut direset; kategori manual dipertahankan.
  getDB().prepare("DELETE FROM chat_categories WHERE chat_jid = ? AND assigned_by != 'manual'").run(chatJid);
  return getDB().prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid).changes;
}

export function clearMessages() {
  getDB().prepare('DELETE FROM chat_bot').run();
  getDB().prepare('DELETE FROM chat_categories').run();
  getDB().prepare('DELETE FROM contacts').run();
  getDB().prepare('DELETE FROM messages').run();
  getDB().prepare('DELETE FROM sqlite_sequence WHERE name = ?').run('messages');
}


export function getStats() {
  const db = getDB();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  return {
    totalMessages: one('SELECT COUNT(*) c FROM messages'),
    totalChats: one('SELECT COUNT(DISTINCT chat_jid) c FROM messages'),
    botReplies: one('SELECT COUNT(*) c FROM messages WHERE is_from_bot = 1'),
    incoming: one('SELECT COUNT(*) c FROM messages WHERE is_from_bot = 0'),
    today: one('SELECT COUNT(*) c FROM messages WHERE timestamp >= ?', startOfDay.getTime()),
    // 7 hari terakhir (untuk grafik)
    daily: Array.from({ length: 7 }, (_, i) => {
      const from = new Date(startOfDay); from.setDate(from.getDate() - (6 - i));
      const to = new Date(from); to.setDate(to.getDate() + 1);
      return {
        date: from.getTime(),
        incoming: one('SELECT COUNT(*) c FROM messages WHERE is_from_bot = 0 AND timestamp >= ? AND timestamp < ?', from.getTime(), to.getTime()),
        bot: one('SELECT COUNT(*) c FROM messages WHERE is_from_bot = 1 AND timestamp >= ? AND timestamp < ?', from.getTime(), to.getTime()),
      };
    }),
  };
}

export function getRecentMessages(limit = 8) {
  return getDB().prepare(
    `SELECT m.id, m.chat_jid, m.sender, m.content, m.is_from_bot, m.timestamp, m.media_type,
            c.name as contact_name, c.phone as contact_phone, c.pic_ok as pic_ok, c.pic_version as pic_version
     FROM messages m LEFT JOIN contacts c ON c.jid = m.chat_jid
     ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`
  ).all(limit);
}


/* ---------- Kategori customer ---------- */

export function listCategories() {
  return getDB().prepare(`
    SELECT c.id, c.name, c.description, c.color, c.created, c.wa_label_id, c.wa_predefined,
           (SELECT COUNT(*) FROM chat_categories cc WHERE cc.category_id = c.id) AS total
    FROM categories c ORDER BY c.name COLLATE NOCASE
  `).all();
}

export function getCategory(id) {
  return getDB().prepare('SELECT * FROM categories WHERE id = ?').get(id) || null;
}

export function createCategory({ name, description = '', color = '#2f6f9f' }) {
  const r = getDB().prepare('INSERT INTO categories (name, description, color, created) VALUES (?, ?, ?, ?)')
    .run(name, description, color, Date.now());
  return Number(r.lastInsertRowid);
}

export function updateCategory(id, { name, description, color }) {
  const cur = getCategory(id);
  if (!cur) return false;
  getDB().prepare('UPDATE categories SET name = ?, description = ?, color = ? WHERE id = ?')
    .run(name ?? cur.name, description ?? cur.description, color ?? cur.color, id);
  return true;
}

export function deleteCategory(id) {
  getDB().prepare('DELETE FROM chat_categories WHERE category_id = ?').run(id);
  return getDB().prepare('DELETE FROM categories WHERE id = ?').run(id).changes > 0;
}

export function getChatCategory(chatJid) {
  return getDB().prepare(`
    SELECT cc.chat_jid, cc.category_id, cc.assigned_by, cc.confidence, cc.reason, cc.updated,
           cat.name AS category_name, cat.color AS category_color
    FROM chat_categories cc JOIN categories cat ON cat.id = cc.category_id
    WHERE cc.chat_jid = ?`).get(chatJid) || null;
}

export function setChatCategory(chatJid, categoryId, { by = 'ai', confidence = null, reason = '' } = {}) {
  getDB().prepare(`
    INSERT INTO chat_categories (chat_jid, category_id, assigned_by, confidence, reason, updated)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET
      category_id = excluded.category_id, assigned_by = excluded.assigned_by,
      confidence = excluded.confidence, reason = excluded.reason, updated = excluded.updated
  `).run(chatJid, categoryId, by, confidence, String(reason || '').slice(0, 300), Date.now());
}

export function clearChatCategory(chatJid) {
  return getDB().prepare('DELETE FROM chat_categories WHERE chat_jid = ?').run(chatJid).changes > 0;
}


/* ---------- Sinkronisasi Label WhatsApp ---------- */

// Palet warna label WhatsApp Business (ID 0-19). Hex ini perkiraan; WhatsApp hanya mengirim nomor warna.
const WA_LABEL_COLORS = [
  '#ff9485', '#64c4ff', '#ffd429', '#dfaef0', '#99b6c1', '#55ccb3', '#ff9dff', '#d3a91d', '#6d7cce', '#d7e752',
  '#00d0e2', '#ffc5c7', '#93ceac', '#f74848', '#00a0f4', '#83e422', '#ffaf04', '#b5ebff', '#9ba6ff', '#9368cf',
];
export function waColorHex(id) {
  const n = Number(id);
  return WA_LABEL_COLORS[Number.isInteger(n) && n >= 0 ? n % WA_LABEL_COLORS.length : 0];
}

// Label bawaan WhatsApp Business (predefinedId 1-5): kriteria awal bagi AI agar tidak bergantung pada bahasa nama label.
const PREDEFINED_HINTS = {
  1: 'Pelanggan baru yang pertama kali menghubungi, masih bertanya-tanya.',
  2: 'Pelanggan menyatakan ingin memesan/membeli dan sedang memproses pesanan.',
  3: 'Menunggu pembayaran: pesanan sudah ada tetapi pelanggan belum membayar atau belum mengirim bukti.',
  4: 'Sudah dibayar: pelanggan mengirim bukti transfer/konfirmasi pembayaran, atau menyatakan sudah membayar.',
  5: 'Pesanan selesai: barang/jasa sudah diterima dan urusan tuntas.',
};

export function getCategoryByLabel(labelId) {
  return getDB().prepare('SELECT * FROM categories WHERE wa_label_id = ?').get(String(labelId)) || null;
}

/** Terapkan perubahan label dari WhatsApp (labels.edit) ke tabel kategori. Mengembalikan 'created'|'updated'|'deleted'|'noop'. */
export function upsertWaLabel({ id, name, color, deleted, predefinedId }) {
  if (id == null) return 'noop';
  const db = getDB();
  const labelId = String(id);
  const existing = getCategoryByLabel(labelId);

  if (deleted) {
    if (!existing) return 'noop';
    deleteCategory(existing.id);
    return 'deleted';
  }

  let label = String(name || '').trim().slice(0, 40);
  if (!label) {
    if (existing) return 'noop';
    label = `Label ${labelId}`;
  }
  const hex = waColorHex(color);
  const pre = predefinedId != null && predefinedId !== '' ? String(predefinedId) : null;

  // Hindari bentrok nama (UNIQUE NOCASE) bila dua label WhatsApp bernama sama.
  const clash = db.prepare('SELECT id, wa_label_id FROM categories WHERE name = ? COLLATE NOCASE').get(label);
  if (clash && clash.id !== existing?.id && clash.wa_label_id && clash.wa_label_id !== labelId) label = `${label.slice(0, 34)} #${labelId}`;

  if (existing) {
    db.prepare('UPDATE categories SET name = ?, color = ?, wa_predefined = COALESCE(?, wa_predefined) WHERE id = ?')
      .run(label, hex, pre, existing.id);
    return 'updated';
  }

  // Kategori lokal lama (v2.6.0) dengan nama sama diadopsi: kriteria & penetapan chat-nya dipertahankan.
  if (clash && !clash.wa_label_id) {
    db.prepare('UPDATE categories SET wa_label_id = ?, name = ?, color = ?, wa_predefined = ? WHERE id = ?').run(labelId, label, hex, pre, clash.id);
    return 'updated';
  }

  const hint = pre && PREDEFINED_HINTS[pre] ? PREDEFINED_HINTS[pre] : '';
  db.prepare('INSERT INTO categories (name, description, color, created, wa_label_id, wa_predefined) VALUES (?, ?, ?, ?, ?, ?)')
    .run(label, hint, hex, Date.now(), labelId, pre);
  return 'created';
}

/** Kategori yang boleh dipilih AI: label WhatsApp bila sudah tersinkron, jika belum semua kategori yang ada. */
export function listClassifiableCategories() {
  const all = listCategories();
  const wa = all.filter(c => c.wa_label_id);
  return wa.length ? wa : all;
}

export function countWaLabels() {
  return getDB().prepare('SELECT COUNT(*) c FROM categories WHERE wa_label_id IS NOT NULL').get().c;
}

/** Hapus semua kategori berasal dari WhatsApp (dipakai saat logout; label milik akun lain). */
export function clearWaLabels() {
  const db = getDB();
  db.prepare('DELETE FROM chat_categories WHERE category_id IN (SELECT id FROM categories WHERE wa_label_id IS NOT NULL)').run();
  db.prepare('DELETE FROM categories WHERE wa_label_id IS NOT NULL').run();
}


/* ---------- Balas otomatis per chat ---------- */

/** Bot membalas chat ini? (Default: ya. Saklar global AUTO_REPLY_ENABLED tetap berlaku di atasnya.) */
export function isBotEnabledForChat(chatJid) {
  const r = getDB().prepare('SELECT enabled FROM chat_bot WHERE chat_jid = ?').get(chatJid);
  return r ? !!r.enabled : true;
}

export function setBotEnabledForChat(chatJid, enabled) {
  getDB().prepare(`
    INSERT INTO chat_bot (chat_jid, enabled, updated) VALUES (?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET enabled = excluded.enabled, updated = excluded.updated
  `).run(chatJid, enabled ? 1 : 0, Date.now());
}


/* ---------- Pengaturan aplikasi (prompt) di database ---------- */

export function getAppSetting(key) {
  const r = getDB().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function setAppSetting(key, value) {
  getDB().prepare(`
    INSERT INTO app_settings (key, value, updated) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated
  `).run(key, String(value ?? ''), Date.now());
}
