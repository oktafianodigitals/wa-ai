import express from 'express';
import { APP_VERSION } from './version.js';
import { getSock, logout } from './baileys.js';
import {
  clearChat, getContact, getHistory, listChats, getStats, getRecentMessages, saveMessage,
  getMessage, listChatMediaPaths, listCategories, getCategory, updateCategory,
  deleteCategory, getChatCategory, setChatCategory, clearChatCategory, isBotEnabledForChat, setBotEnabledForChat,
} from './db.js';
import { mediaFilePath, isInlineSafe, deleteMediaFiles } from './media.js';
import { classifyChat, classifyAll } from './categories.js';
import { getLabelSyncStatus, resyncLabels, pushChatLabel } from './labels.js';
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
  res.set('Cache-Control', 'no-store');
  try {
    const sock = getSock();
    res.json({
      status: 'ok',
      connected: !!sock?.user,
      timestamp: Date.now(),
      version: APP_VERSION,
    });
  } catch (err) {
    res.json({ status: 'ok', timestamp: Date.now(), version: APP_VERSION });
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
    const history = getHistory(decoded, limit).map(({ media_path, media_text, media_type, media_name, media_mime, media_size, ...m }) => ({
      ...m,
      media: media_type ? {
        type: media_type, name: media_name, mime: media_mime, size: media_size,
        available: !!media_path, // false = tidak diunduh (terlalu besar / gagal)
      } : null,
    }));
    const c = getContact(decoded);
    const cat = getChatCategory(decoded);
    res.json({
      jid: decoded,
      category: cat ? {
        id: cat.category_id, name: cat.category_name, color: cat.category_color,
        by: cat.assigned_by, confidence: cat.confidence, reason: cat.reason,
      } : null,
      bot_enabled: isBotEnabledForChat(decoded),
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

// Saklar balas otomatis per chat. Mati = bot tidak membalas chat ini (kategorisasi tetap jalan).
router.put('/chats/:jid/bot', (req, res) => {
  try {
    const jid = req.params.jid;
    if (!isValidJid(jid)) return res.status(400).json({ error: 'jid tidak valid' });
    const en = req.body?.enabled;
    const enabled = en === true || en === 'true' || en === 1 || en === '1';
    setBotEnabledForChat(jid, enabled);
    if (!enabled) cancelDebounce(jid); // batalkan balasan yang masih menunggu
    console.log(`[BOT] Balas otomatis ${enabled ? 'AKTIF' : 'MATI'} untuk ${jid}`);
    emit('chat-updated', { jid });
    res.json({ ok: true, bot_enabled: enabled, global_enabled: !!config.AUTO_REPLY_ENABLED });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bersihkan percakapan: hapus riwayat satu chat sehingga konteks AI mulai dari nol.
router.delete('/chats/:jid', (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid || '');
    if (!isValidJid(jid)) return res.status(400).json({ error: 'jid tidak valid' });
    cancelDebounce(jid); // batalkan balasan AI yang masih menunggu untuk chat ini
    cancelDebounce(`cat:${jid}`);
    deleteMediaFiles(listChatMediaPaths(jid)); // hapus lampiran dari disk
    const deleted = clearChat(jid);
    emit('chat-updated', { jid });
    console.log(`[CHAT] Percakapan ${jid} dibersihkan (${deleted} pesan)`);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Lampiran ---------- */

// Menyajikan lampiran. Hanya gambar/audio/video yang aman ditampilkan langsung; selain itu selalu diunduh.
router.get('/media/:id', (req, res) => {
  const row = getMessage(parseInt(req.params.id, 10));
  const file = row?.media_path ? mediaFilePath(row.media_path) : null;
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });
  const inline = isInlineSafe(row.media_mime) && req.query.download !== '1';
  const name = String(row.media_name || 'file').replace(/[^\w.\- ()\[\]]/g, '_');
  res.set({
    'Content-Type': isInlineSafe(row.media_mime) ? String(row.media_mime).split(';')[0] : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(row.media_name || 'file')}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=3600',
  });
  res.sendFile(file);
});

/* ---------- Kategori customer ---------- */

function parseCategoryBody(b = {}, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name ?? '').trim();
    if (!name) throw Object.assign(new Error('Nama kategori wajib diisi'), { status: 400 });
    if (name.length > 40) throw Object.assign(new Error('Nama kategori maksimal 40 karakter'), { status: 400 });
    out.name = name;
  }
  if (b.description !== undefined) out.description = String(b.description).trim().slice(0, 500);
  if (b.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) throw Object.assign(new Error('Warna harus berformat #RRGGBB'), { status: 400 });
    out.color = String(b.color).toLowerCase();
  }
  return out;
}

function categoryError(res, err) {
  if (/UNIQUE/i.test(err.message)) return res.status(409).json({ error: 'Nama kategori sudah dipakai' });
  res.status(err.status || 500).json({ error: err.message });
}

// Kategori = Label WhatsApp Business. Dibuat/diubah/dihapus di aplikasi WhatsApp, bukan di sini;
// dashboard hanya menyimpan "kriteria untuk AI" per label.
router.get('/categories', (req, res) => {
  try { res.json({ categories: listCategories(), sync: getLabelSyncStatus() }); } catch (err) { categoryError(res, err); }
});

// Ambil ulang label & pemasangannya dari WhatsApp.
router.post('/categories/sync', async (req, res) => {
  try {
    const r = await resyncLabels({ full: true });
    res.json({ ok: true, ...r, sync: getLabelSyncStatus(), categories: listCategories() });
  } catch (err) { res.status(409).json({ error: err.message, sync: getLabelSyncStatus() }); }
});

router.post('/categories/classify-all', (req, res) => {
  try { res.json({ ok: true, ...classifyAll() }); } catch (err) { categoryError(res, err); }
});

router.put('/categories/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!getCategory(id)) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    const cur = getCategory(id);
    const body = parseCategoryBody(req.body, true);
    if (cur.wa_label_id) { delete body.name; delete body.color; } // nama & warna mengikuti WhatsApp
    updateCategory(id, body);
    emit('chat-updated', { jid: null });
    res.json({ ok: true, category: getCategory(id) });
  } catch (err) { categoryError(res, err); }
});

router.delete('/categories/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (getCategory(id)?.wa_label_id) return res.status(409).json({ error: 'Kategori ini adalah Label WhatsApp. Hapus labelnya di aplikasi WhatsApp Business.' });
    if (!deleteCategory(id)) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
    emit('chat-updated', { jid: null });
    res.json({ ok: true });
  } catch (err) { categoryError(res, err); }
});

// Tetapkan kategori secara manual (AI tidak akan menimpanya). category_id null = kembalikan ke otomatis (AI).
router.put('/chats/:jid/category', (req, res) => {
  try {
    const jid = req.params.jid;
    if (!isValidJid(jid)) return res.status(400).json({ error: 'jid tidak valid' });
    const cid = req.body?.category_id;
    const prevCat = getChatCategory(jid);
    const prev = prevCat ? getCategory(prevCat.category_id) : null;
    if (cid === null || cid === undefined || cid === '') {
      clearChatCategory(jid);
      pushChatLabel(jid, null, prev); // lepas labelnya di WhatsApp juga
    } else {
      const cat = getCategory(parseInt(cid, 10));
      if (!cat) return res.status(404).json({ error: 'Kategori tidak ditemukan' });
      setChatCategory(jid, cat.id, { by: 'manual', confidence: null, reason: 'Ditetapkan manual' });
      pushChatLabel(jid, cat, prev);
    }
    emit('chat-updated', { jid });
    res.json({ ok: true, category: getChatCategory(jid) });
  } catch (err) { categoryError(res, err); }
});

// Minta AI menentukan kategori sekarang (menimpa penetapan manual karena diminta eksplisit).
router.post('/chats/:jid/categorize', async (req, res) => {
  try {
    const jid = req.params.jid;
    if (!isValidJid(jid)) return res.status(400).json({ error: 'jid tidak valid' });
    const r = await classifyChat(jid, { force: true });
    res.status(r.ok ? 200 : 502).json({ ...r, current: getChatCategory(jid) });
  } catch (err) { categoryError(res, err); }
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
