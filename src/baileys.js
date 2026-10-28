import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import QRCode from 'qrcode';
import { config } from './config.js';
import { saveMessage, clearMessages, clearWaLabels, getHistory, formatHistoryForAI, isBotEnabledForChat } from './db.js';
import { chatWithAI } from './ai.js';
import { transcribeAudio } from './stt.js';
import { selectVoiceFile, getVoicePath, getVoiceFiles, getVoiceMime } from './voice-select.js';
import { formatAIError } from './ai.js';
import { debounce } from './debounce.js';
import { rememberFromMessage, rememberContacts, queueAvatar, queueAllAvatars, clearAvatars } from './contacts.js';
import { emit, setLatestQr, clearLatestQr } from './socket.js';
import { useSingleFileAuthState } from './single-file-auth.js';
import { describeIncoming, storeMedia, mediaFilePath, clearAllMedia } from './media.js';
import { classifyChat } from './categories.js';
import { initLabels, attachLabelListeners, scheduleAutoSync, createSyncLogStream } from './labels.js';

let sock;
let authState;
let logoutPending = false;
let reconnectTimer = null;
let connecting = false;

// Hanya log sinkronisasi app-state yang diteruskan (lihat labels.js); sisanya tetap diam.
const logger = pino({ level: 'info' }, createSyncLogStream());

export function getSock() {
  return sock;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!connecting && !logoutPending) {
      startWA();
    }
  }, 3000);
}

export async function startWA() {
  if (connecting) return;
  connecting = true;

  clearLatestQr();

  if (sock) {
    try { sock.end(new Error('restart')); } catch {}
    sock = null;
  }

  const auth = useSingleFileAuthState(config.TG_SESSION_FILE);
  authState = auth;
  const { state, saveCreds } = auth;

  const newSock = makeWASocket({
    auth: state,
    logger,
    browser: ['WA-AI-Bot', 'Safari', '3.0'],
  });
  sock = newSock;
  const thisSock = newSock;

  thisSock.ev.on('creds.update', saveCreds);

  thisSock.ev.on('connection.update', async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WA] Scan QR code above to login');
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          setLatestQr(qrDataUrl);
        } catch (err) {
          console.error('[WA] QR render failed:', err.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const wasLoggedOut = statusCode === DisconnectReason.loggedOut || logoutPending;

        if (wasLoggedOut) {
          logoutPending = false;
          clearLatestQr();
          try { emit('status', { connected: false, user: null }); } catch {}
        }

        if (sock !== thisSock) {
          return;
        }

        connecting = false;
        const errMsg = lastDisconnect?.error?.message || lastDisconnect?.error?.stack;
        console.log(`[WA] Connection closed. Status: ${statusCode}. Reconnect: ${!wasLoggedOut}`
          + (errMsg ? ` — ${errMsg}` : ''));
        if (!wasLoggedOut) {
          try { emit('status', { connected: false }); } catch {}
        }
        scheduleReconnect();
      }

      if (connection === 'open') {
        if (sock !== thisSock) return;
        connecting = false;
        console.log('[WA] Connected successfully!');
        clearLatestQr();
        try { emit('status', { connected: true, user: sock.user }); } catch {}
        setTimeout(() => queueAllAvatars(getSock), 3000);
        scheduleAutoSync(() => sock === thisSock);
      }
    } catch (e) {
      console.error('[WA] connection.update error:', e?.message || e);
    }
  });

  initLabels({ getSock: () => sock, getKeys: () => state.keys });
  attachLabelListeners(thisSock);

  sock.ev.on('contacts.upsert', (list) => { try { rememberContacts(list); } catch {} });
  sock.ev.on('contacts.update', (list) => { try { rememberContacts(list); } catch {} });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      await handleMessage(msg);
    }
  });

  return sock;
}

/**
 * Memproses satu pesan masuk. Semua jenis pesan (teks, gambar, dokumen apa pun, video, audio,
 * stiker, kontak, lokasi, dll) disimpan dan dibalas; hanya pesan teknis WhatsApp yang diabaikan.
 * `ctx.sock` dipakai untuk pengujian; secara normal memakai koneksi aktif.
 */
export async function handleMessage(msg, ctx = {}) {
  if (!msg.message) return;
  if (msg.key.fromMe) return;

  const chatJid = msg.key.remoteJid;
  if (!chatJid || isJidGroup(chatJid) || isJidBroadcast(chatJid) || isJidNewsletter(chatJid)) return;
  const getS = () => ctx.sock || sock;

  const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);

  const info = describeIncoming(msg);
  if (!info) return; // pesan teknis (reaksi, edit, protokol, ...)

  let content = info.content;
  let media = null;

  if (info.media) {
    media = await storeMedia(msg, info, { sock: getS() });

    if (info.kind === 'voice' || info.kind === 'audio') {
      // Voice note / audio: transkripsikan agar AI memahami isinya.
      try {
        if (!media.path) throw new Error(media.error || 'audio tidak tersedia');
        if (media.size > 25 * 1024 * 1024) throw new Error('audio terlalu besar untuk STT');
        const buffer = fs.readFileSync(mediaFilePath(media.path));
        const transcript = await transcribeAudio(buffer, media.name, { contentType: String(media.mime || 'audio/ogg').split(';')[0] });
        console.log(`[STT] Transcribed: "${transcript}"`);
        content = transcript ? `[Voice Note] ${transcript}` : '[Voice Note - tidak ada ucapan terdeteksi]';
      } catch (err) {
        console.error('[STT] Failed to transcribe:', err.message);
        content = info.kind === 'voice' ? '[Voice Note - tidak bisa ditranskripsi]' : '[Audio - tidak bisa ditranskripsi]';
      }
    } else if (media.error) {
      console.warn(`[MEDIA] ${media.name}: ${media.error}`);
      const tooBig = /melebihi batas/i.test(media.error);
      content += tooBig
        ? ` (file tidak dapat diunduh: ukuran melebihi batas ${config.MAX_FILE_MB} MB)`
        : ' (file tidak dapat diunduh)';
    } else {
      console.log(`[MEDIA] Tersimpan: ${media.name} (${media.mime || '?'}, ${media.size} B)`);
    }
  }

  saveMessage(chatJid, sender, content, false, media);
  try { rememberFromMessage(msg); queueAvatar(getS, chatJid); } catch (e) { console.warn('[CONTACT]', e.message); }
  emit('chat-updated', { jid: chatJid });
  console.log(`[MSG] ${sender}: ${content}`);

  // Kategorisasi berjalan sendiri (tidak menunggu balasan, tetap jalan walau balas otomatis mati).
  const delay = (Number.isFinite(config.DEBOUNCE_MS) ? config.DEBOUNCE_MS : 8000) + 1500;
  debounce(`cat:${chatJid}`, async () => {
    const r = await classifyChat(chatJid);
    if (r && !r.ok) console.warn(`[CATEGORY] Gagal mengklasifikasi ${chatJid}: ${r.error}`);
  }, delay);

  // Saklar global dan saklar per chat (dashboard) harus sama-sama aktif agar bot membalas.
  if (!config.AUTO_REPLY_ENABLED || !isBotEnabledForChat(chatJid)) {
    return;
  }

  debounce(chatJid, async () => {
    const s = getS();
    if (!config.AUTO_REPLY_ENABLED || !isBotEnabledForChat(chatJid)) return;
    try {
      const reply = await chatWithAI(chatJid, content);
      saveMessage(chatJid, 'bot', reply, true);
      emit('chat-updated', { jid: chatJid });
      console.log(`[REPLY] ${chatJid}: ${reply}`);
      await s.sendMessage(chatJid, { text: reply });

      const voiceFiles = getVoiceFiles();
      if (voiceFiles.length > 0) {
        const history = getHistory(chatJid, 20);
        const aiHistory = formatHistoryForAI(history);
        const voiceFile = await selectVoiceFile(aiHistory);
        if (voiceFile) {
          const voicePath = getVoicePath(voiceFile);
          const audioBuffer = fs.readFileSync(voicePath);
          await s.sendMessage(chatJid, {
            audio: audioBuffer,
            mimetype: getVoiceMime(voiceFile),
            ptt: true,
          });
          console.log(`[VOICE] Sent: ${voiceFile}`);
        }
      }
    } catch (err) {
      console.error('[AI] Error:', formatAIError(err));
      if (s) {
        try {
          await s.sendMessage(chatJid, { text: 'Maaf, ada gangguan. Coba lagi nanti.' });
        } catch {}
      }
    }
  });
}

export function logout() {
  console.log('[LOGOUT] Clearing session and database...');

  logoutPending = true;

  try {
    sock?.end(new Error('manual logout'));
  } catch {}

  try {
    authState?.clearState?.();
  } catch (err) {
    console.error('[LOGOUT] Failed to clear session file:', err.message);
  }

  try {
    clearMessages();
    clearWaLabels();
    clearAvatars();
    clearAllMedia();
  } catch (err) {
    console.error('[LOGOUT] Failed to clear database:', err.message);
  }

  clearLatestQr();
  emit('status', { connected: false, user: null });

  return true;
}
