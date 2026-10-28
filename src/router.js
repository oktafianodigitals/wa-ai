import express from 'express';
import { getSock, logout } from './baileys.js';
import { clearChat, getContact, getHistory, listChats, getStats, getRecentMessages, saveMessage } from './db.js';
import {
  getVoiceDetails, getVoicePath, saveVoiceFile, deleteVoiceFile, sanitizeVoiceName, getVoiceMime,
} from './voice-select.js';
import { pingAI, diagnoseAI } from './ai-client.js';
import { emit } from './socket.js';
import fs from 'fs';
import { cancelDebounce } from './debounce.js';
import { avatarFile, queueAvatar, phoneFromJid } from './contacts.js';
import { getSettings, updateSettings } from './settings.js';
import { config } from './config.js';

const router = express.Router();

function isValidJid(jid) {
  if (typeof jid !== 'string') return false;
  const s = jid.trim();
  if (!s) return false;
  return /@s\.whatsapp\.net$|@g\.us$|@broadcast$/.test(s) || s.includes('@');
}

router.get('/settings', (req, res) => {
  try {
    res.json(getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  try {
    const sock = getSock();
    res.json({
      status: 'ok',
      connected: !!sock?.user,
      timestamp: Date.now(),
      version: '2.5.3',
    });
  } catch (err) {
    res.json({ status: 'ok', timestamp: Date.now(), version: '2.5.3' });
  }
});

router.get('/ai/status', async (req, res) => {
  try {
    const ping = await pingAI();
    res.json({
      ok: true,
      baseUrl: config.AI_BASE_URL,
      model: config.AI_MODEL,
      hasKey: !!config.AI_API_KEY,
      enabled: !!config.AUTO_REPLY_ENABLED,
      reachable: !!ping.reachable,
      authProblem: !!ping.authProblem,
      latency: ping.ms ?? null,
      models: ping.models || [],
      modelAvailable: ping.models?.length ? ping.models.includes(config.AI_MODEL) : null,
      error: ping.error || null,
      hint: ping.hint || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ai/models', async (req, res) => {
  const ping = await pingAI({ timeoutMs: 8000 });
  if (!ping.reachable) return res.status(502).json({ error: ping.error, hint: ping.hint, models: [] });
  if (ping.authProblem) return res.status(401).json({ error: 'API key ditolak', hint: ping.hint, models: [] });
  res.json({ models: ping.models });
});

router.post('/ai/models', async (req, res) => {
  const b = req.body || {};
  const ping = await pingAI({
    baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : undefined,
    apiKey: typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : undefined,
    timeoutMs: 8000,
  });
  if (!ping.reachable) return res.status(502).json({ error: ping.error, hint: ping.hint, models: [] });
  if (ping.authProblem) return res.status(401).json({ error: 'API key ditolak', hint: ping.hint, models: [] });
  res.json({ models: ping.models });
});

// Diagnosa bertahap. Body opsional: { baseUrl, apiKey, model } agar bisa menguji form sebelum disimpan.
router.post('/ai/test', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await diagnoseAI({
      baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : undefined,
      apiKey: typeof b.apiKey === 'string' ? b.apiKey.trim() : undefined,
      model: typeof b.model === 'string' ? b.model.trim() : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, steps: [] });
  }
});

router.get('/status', (req, res) => {
  try {
    const sock = getSock();
    res.json({
      connected: sock?.user ? true : false,
      user: sock?.user || null,
    });
  } catch (err) {
    res.json({ connected: false, user: null });
  }
});

router.get('/history/:jid', (req, res) => {
  try {
    const { jid } = req.params;
    if (!jid) return res.status(400).json({ error: 'jid required' });
    const decoded = decodeURIComponent(jid);
    let limit = parseInt(req.query.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = config.MAX_HISTORY;
    if (limit > 200) limit = 200;
    const history = getHistory(decoded, limit);
    const c = getContact(decoded);
    res.json({
      jid: decoded,
      messages: history,
      contact: {
        name: c?.name || '', phone: c?.phone || phoneFromJid(decoded),
        pic_ok: c?.pic_ok || 0, pic_version: c?.pic_version || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/avatar/:jid', (req, res) => {
  const jid = String(req.params.jid || '');
  if (!isValidJid(jid)) return res.status(400).end();
  const c = getContact(jid);
  const file = avatarFile(jid);
  if (!c?.pic_ok || !fs.existsSync(file)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('image/jpeg').sendFile(file);
});

router.post('/contacts/refresh', (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!isValidJid(jid)) return res.status(400).json({ error: 'jid tidak valid' });
  queueAvatar(getSock, jid, { force: true });
  res.json({ ok: true });
});

router.get('/chats', (req, res) => {
  try {
    const chats = listChats();
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bersihkan percakapan: hapus riwayat satu chat sehingga konteks AI mulai dari nol.
router.delete('/chats/:jid', (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid || '');
    if (!isValidJid(jid)) return res.status(400).json({ error: 'jid tidak valid' });
    cancelDebounce(jid); // batalkan balasan AI yang masih menunggu untuk chat ini
    const deleted = clearChat(jid);
    emit('chat-updated', { jid });
    console.log(`[CHAT] Percakapan ${jid} dibersihkan (${deleted} pesan)`);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/voice-files', (req, res) => {
  try {
    const details = getVoiceDetails();
    res.json({ files: details.map(d => d.name), details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/voice-files/:name/audio', (req, res) => {
  const safe = sanitizeVoiceName(req.params.name);
  if (!safe) return res.status(400).json({ error: 'Nama file tidak valid' });
  const p = getVoicePath(safe);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File tidak ditemukan' });
  res.type(getVoiceMime(safe).split(';')[0]);
  res.sendFile(p);
});

// Upload: body mentah (audio), nama file di query ?name=
router.post('/voice-files', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  try {
    const name = String(req.query.name || '');
    const saved = saveVoiceFile(name, req.body);
    res.json({ ok: true, name: saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/voice-files/:name', (req, res) => {
  try {
    res.json({ ok: true, name: deleteVoiceFile(req.params.name) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/db/stats', (req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    res.status(500).json({ error: err.message, totalMessages: 0, totalChats: 0 });
  }
});

router.get('/recent', (req, res) => {
  try {
    res.json({ messages: getRecentMessages(8) });
  } catch (err) {
    res.status(500).json({ error: err.message, messages: [] });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { jid, text } = req.body || {};
    if (!jid || typeof jid !== 'string') {
      return res.status(400).json({ error: 'jid required' });
    }
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text required' });
    }
    const jidTrim = jid.trim();
    const textTrim = text.trim();
    if (!jidTrim || !textTrim) {
      return res.status(400).json({ error: 'jid and text required' });
    }
    if (textTrim.length > 4000) {
      return res.status(400).json({ error: 'text too long (max 4000)' });
    }
    const sock = getSock();
    if (!sock?.user) {
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }
    await sock.sendMessage(jidTrim, { text: textTrim });
    saveMessage(jidTrim, 'manual', textTrim, true);
    emit('chat-updated', { jid: jidTrim });
    res.json({ ok: true, jid: jidTrim, text: textTrim });
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

router.get('/logs', async (req, res) => {
  try {
    const { getLogs } = await import('./logger.js');
    res.type('text/plain').send(getLogs());
  } catch (err) {
    res.status(500).type('text/plain').send('Failed to read logs: ' + err.message);
  }
});

router.post('/logs/clear', async (req, res) => {
  try {
    const { clearLogs } = await import('./logger.js');
    clearLogs();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export function initRouter(app) {
  app.use('/api', router);
}
