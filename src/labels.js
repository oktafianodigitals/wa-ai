// Sinkronisasi Label WhatsApp (fitur WhatsApp Business) <-> kategori customer.
//  - Label di WhatsApp  -> tabel `categories` (nama, warna). Bot tidak membuat kategori sendiri.
//  - Label terpasang pada chat di WhatsApp -> kategori chat di dashboard.
//  - Kategori yang ditetapkan bot/dashboard -> label dipasang ke chat di WhatsApp.
import { config } from './config.js';
import {
  upsertWaLabel, getCategoryByLabel, getCategory, getChatCategory, setChatCategory, clearChatCategory, countWaLabels,
} from './db.js';
import { emit } from './socket.js';

let getSockFn = () => null;
let getKeysFn = () => null;

const status = { lastSyncAt: 0, syncing: false, lastError: '' };
const orphans = new Map(); // `${jid}|${labelId}` -> {jid, labelId}: asosiasi yang tiba sebelum labelnya dikenal
let busyUntil = 0;          // peristiwa selama sinkron penuh tidak menimpa penetapan yang sudah ada
let notifyTimer = null;
let pushChain = Promise.resolve();

// Log internal Baileys yang terkait sinkronisasi app-state ditangkap agar penyebab label kosong terlihat.
const syncNotes = [];
export function createSyncLogStream() {
  return {
    write(line) {
      if (!/sync/i.test(line)) return;
      try {
        const o = JSON.parse(line);
        const msg = String(o.msg || '');
        if (!/resync|sync|restored state/i.test(msg)) return;
        const err = o.error ? ` — ${String(o.error).split('\n')[0]}` : '';
        const note = `${msg}${o.name ? ` [${o.name}]` : ''}${err}`;
        if (/failed|error|not found/i.test(note) || o.level >= 40) console.warn(`[WA-SYNC] ${note}`);
        else console.log(`[WA-SYNC] ${note}`);
        syncNotes.push(note); if (syncNotes.length > 20) syncNotes.shift();
      } catch { /* abaikan */ }
    },
  };
}

/** Sinkron otomatis setelah terhubung; diulang bila belum ada label (kunci sinkronisasi bisa datang terlambat). */
export function scheduleAutoSync(isCurrent) {
  for (const delay of [5000, 45000, 150000]) {
    setTimeout(async () => {
      if (!config.WA_LABEL_SYNC_ENABLED || !isCurrent() || (delay > 5000 && countWaLabels() > 0)) return;
      try { await resyncLabels({ full: true }); } catch (e) { console.warn('[LABEL] Sinkron otomatis gagal:', e?.message || e); }
    }, delay).unref?.();
  }
}

export function initLabels({ getSock, getKeys }) {
  getSockFn = getSock;
  getKeysFn = getKeys || (() => null);
}

function notify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => { emit('categories-updated', {}); emit('chat-updated', { jid: null }); }, 400);
}

export function getLabelSyncStatus() {
  return {
    enabled: !!config.WA_LABEL_SYNC_ENABLED,
    connected: !!getSockFn()?.user,
    syncing: status.syncing,
    lastSyncAt: status.lastSyncAt,
    lastError: status.lastError,
    labels: countWaLabels(),
  };
}

function isChatAssoc(a) {
  return a && (a.type === 'label_jid' || a.type === 'chat') && a.chatId;
}

function applyAssociation(op, jid, labelId) {
  const cat = getCategoryByLabel(labelId);
  if (!cat) { if (op === 'add') orphans.set(`${jid}|${labelId}`, { jid, labelId }); return; }
  const cur = getChatCategory(jid);

  if (op === 'add') {
    if (cur?.category_id === cat.id) return; // gema dari penetapan kita sendiri
    // Saat sinkron penuh (data lama), jangan menimpa penetapan yang sudah ada di dashboard.
    if (Date.now() < busyUntil && cur && cur.assigned_by !== 'wa') return;
    setChatCategory(jid, cat.id, { by: 'wa', confidence: null, reason: 'Label dipasang di WhatsApp' });
    console.log(`[LABEL] ${jid} ← "${cat.name}" (dari WhatsApp)`);
  } else if (cur?.category_id === cat.id) {
    clearChatCategory(jid);
    console.log(`[LABEL] ${jid} ✕ "${cat.name}" (dilepas di WhatsApp)`);
  }
  notify();
}

/** Pasang pendengar peristiwa label pada koneksi baru. */
export function attachLabelListeners(sock) {
  sock.ev.on('labels.edit', (label) => {
    try {
      if (!config.WA_LABEL_SYNC_ENABLED) return;
      const r = upsertWaLabel(label || {});
      if (r === 'created') console.log(`[LABEL] Label baru dari WhatsApp: "${label.name}"`);
      else if (r === 'deleted') console.log(`[LABEL] Label dihapus di WhatsApp: ${label.id}`);
      if (r !== 'noop') {
        status.lastSyncAt = Date.now();
        // Asosiasi yang menunggu label ini
        for (const [key, o] of orphans) {
          if (String(o.labelId) === String(label.id)) { orphans.delete(key); applyAssociation('add', o.jid, o.labelId); }
        }
        notify();
      }
    } catch (e) { console.warn('[LABEL] labels.edit:', e.message); }
  });

  sock.ev.on('labels.association', (evt) => {
    try {
      if (!config.WA_LABEL_SYNC_ENABLED) return;
      const a = evt?.association;
      if (!isChatAssoc(a)) return; // label pada pesan tidak dipakai
      applyAssociation(evt.type === 'remove' ? 'remove' : 'add', a.chatId, a.labelId);
    } catch (e) { console.warn('[LABEL] labels.association:', e.message); }
  });
}

/**
 * Ambil ulang seluruh label dan pemasangannya dari WhatsApp.
 * `full` mengulang dari versi 0 sehingga label yang dibuat sebelum bot terhubung ikut terbaca.
 */
export async function resyncLabels({ full = true } = {}) {
  const sock = getSockFn();
  if (!sock?.user) throw new Error('WhatsApp belum terhubung');
  if (status.syncing) return { started: false, reason: 'sedang berjalan' };
  status.syncing = true; status.lastError = '';
  emit('categories-updated', {});
  busyUntil = Date.now() + 60000;
  try {
    if (full) {
      const keys = getKeysFn();
      if (keys) await keys.set({ 'app-state-sync-version': { regular: null, regular_low: null, regular_high: null } });
    }
    syncNotes.length = 0;
    await sock.resyncAppState(['regular', 'regular_low', 'regular_high'], true);
    status.lastSyncAt = Date.now();
    // resyncAppState tidak melempar error saat gagal; cek apakah data 'regular' benar-benar tersimpan.
    const keys = getKeysFn();
    if (keys) {
      const got = await keys.get('app-state-sync-version', ['regular']);
      if (!got?.regular?.version) {
        const why = syncNotes.filter(n => /failed|not found/i.test(n)).pop() || 'kunci sinkronisasi belum diterima dari HP';
        status.lastError = `WhatsApp tidak mengirim data label (${why}). Pastikan HP online, lalu klik Keluar dan scan QR ulang agar kunci sinkronisasi dikirim.`;
        console.warn('[LABEL] ' + status.lastError);
      }
    }
    console.log(`[LABEL] Sinkron selesai: ${countWaLabels()} label`);
  } catch (e) {
    status.lastError = e?.message || String(e);
    console.warn('[LABEL] Sinkron gagal:', status.lastError);
    throw e;
  } finally {
    status.syncing = false;
    setTimeout(() => { busyUntil = 0; notify(); }, 2000);
    notify();
  }
  return { started: true };
}

/**
 * Cerminkan kategori sebuah chat ke WhatsApp: pasang label baru, lepas label kategori sebelumnya.
 * `cat` null = lepas label `prev` saja. Dijalankan berurutan agar patch app-state tidak bertabrakan.
 */
export function pushChatLabel(chatJid, cat, prev = null) {
  if (!config.WA_LABEL_SYNC_ENABLED) return Promise.resolve(false);
  const job = pushChain.then(async () => {
    const sock = getSockFn();
    if (!sock?.user) return false;
    const newLabel = cat?.wa_label_id || null;
    const oldLabel = prev?.wa_label_id && prev.wa_label_id !== newLabel ? prev.wa_label_id : null;
    if (!newLabel && !oldLabel) return false;
    try {
      if (newLabel) await sock.addChatLabel(chatJid, newLabel);
      if (oldLabel) await sock.removeChatLabel(chatJid, oldLabel);
      return true;
    } catch (e) {
      console.warn(`[LABEL] Gagal memasang label di WhatsApp untuk ${chatJid}: ${e?.message || e}`);
      return false;
    }
  });
  pushChain = job.catch(() => {});
  return job;
}

/** Bantuan untuk pemanggil yang hanya punya id kategori. */
export function pushChatLabelById(chatJid, catId, prevCatId) {
  return pushChatLabel(chatJid, catId ? getCategory(catId) : null, prevCatId ? getCategory(prevCatId) : null);
}
