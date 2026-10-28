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
  `);

  console.log(`[DB] SQLite connected: ${config.DB_FILE}`);
  return db;
}

export function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function saveMessage(chatJid, sender, content, isFromBot = false) {
  const stmt = getDB().prepare(
    'INSERT INTO messages (chat_jid, sender, content, is_from_bot, timestamp) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.run(chatJid, sender, content, isFromBot ? 1 : 0, Date.now());
}

export function getHistory(chatJid, maxHistory = 70) {
  const stmt = getDB().prepare(
    `SELECT id, sender, content, is_from_bot, timestamp FROM messages
     WHERE chat_jid = ?
     ORDER BY timestamp DESC
     LIMIT ?`
  );
  const rows = stmt.all(chatJid, maxHistory);
  return rows.reverse();
}

export function formatHistoryForAI(history) {
  return history.map(msg => ({
    role: msg.is_from_bot ? 'assistant' : 'user',
    content: msg.content,
  }));
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
           c.pic_ok as pic_ok, c.pic_version as pic_version
    FROM messages m
    LEFT JOIN contacts c ON c.jid = m.chat_jid
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
export function clearChat(chatJid) {
  return getDB().prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid).changes;
}

export function clearMessages() {
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
    `SELECT m.id, m.chat_jid, m.sender, m.content, m.is_from_bot, m.timestamp,
            c.name as contact_name, c.phone as contact_phone, c.pic_ok as pic_ok, c.pic_version as pic_version
     FROM messages m LEFT JOIN contacts c ON c.jid = m.chat_jid
     ORDER BY m.timestamp DESC, m.id DESC LIMIT ?`
  ).all(limit);
}
