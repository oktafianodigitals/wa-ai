import express from 'express';
import { getSock, logout } from './baileys.js';
import { getDB, getHistory, listChats } from './db.js';
import { getVoiceFiles } from './voice-select.js';
import { getSettings, updateSettings } from './settings.js';
import { config } from './config.js';

const router = express.Router();

router.get('/settings', (req, res) => {
  res.json(getSettings());
});

router.post('/settings', (req, res) => {
  try {
    const result = updateSettings(req.body || {});
    res.json({ ok: true, ...result, settings: getSettings() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

router.get('/status', (req, res) => {
  const sock = getSock();
  res.json({
    connected: sock?.user ? true : false,
    user: sock?.user || null,
  });
});

router.get('/history/:jid', (req, res) => {
  const { jid } = req.params;
  const limit = parseInt(req.query.limit) || config.MAX_HISTORY;
  const history = getHistory(jid, limit);
  res.json({ jid, messages: history });
});

router.get('/chats', (req, res) => {
  const chats = listChats();
  res.json({ chats });
});

router.get('/voice-files', (req, res) => {
  const files = getVoiceFiles();
  res.json({ files });
});

router.get('/db/stats', (req, res) => {
  const db = getDB();
  const total = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const chats = db.prepare('SELECT COUNT(DISTINCT chat_jid) as count FROM messages').get();
  res.json({ totalMessages: total.count, totalChats: chats.count });
});

router.post('/send', async (req, res) => {
  const { jid, text } = req.body;
  if (!jid || !text) {
    return res.status(400).json({ error: 'jid and text required' });
  }
  const sock = getSock();
  if (!sock?.user) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    await sock.sendMessage(jid, { text });
    res.json({ ok: true, jid, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  try {
    logout();
    res.json({ ok: true, message: 'Sesi dan database dibersihkan. Silakan scan QR baru.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export function initRouter(app) {
  app.use('/api', router);
}
