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
    `SELECT sender, content, is_from_bot FROM messages
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
    SELECT chat_jid,
           COUNT(*) as total_messages,
           MAX(timestamp) as last_time,
           (
             SELECT content FROM messages m2
             WHERE m2.chat_jid = messages.chat_jid
             ORDER BY m2.timestamp DESC LIMIT 1
           ) as last_message
    FROM messages
    GROUP BY chat_jid
    ORDER BY last_time DESC
  `);
  return stmt.all();
}

export function clearMessages() {
  getDB().prepare('DELETE FROM messages').run();
  getDB().prepare('DELETE FROM sqlite_sequence WHERE name = ?').run('messages');
}
