import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import QRCode from 'qrcode';
import { config } from './config.js';
import { saveMessage, clearMessages } from './db.js';
import { chatWithAI } from './ai.js';
import { transcribeAudio } from './stt.js';
import { selectVoiceFile, getVoicePath, getVoiceFiles } from './voice-select.js';
import { debounce } from './debounce.js';
import { emit, setLatestQr, clearLatestQr } from './socket.js';
import { useSingleFileAuthState } from './single-file-auth.js';

let sock;
let authState;
let logoutPending = false;
let reconnectTimer = null;
let connecting = false;

const logger = pino({ level: 'silent' });

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
        emit('status', { connected: false, user: null });
      }

      if (sock !== thisSock) {
        return;
      }

      connecting = false;
      const errMsg = lastDisconnect?.error?.message || lastDisconnect?.error?.stack;
      console.log(`[WA] Connection closed. Status: ${statusCode}. Reconnect: ${!wasLoggedOut}`
        + (errMsg ? ` — ${errMsg}` : ''));
      if (!wasLoggedOut) {
        emit('status', { connected: false });
      }
      scheduleReconnect();
    }

    if (connection === 'open') {
      if (sock !== thisSock) return;
      connecting = false;
      console.log('[WA] Connected successfully!');
      clearLatestQr();
      emit('status', { connected: true, user: sock.user });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      await handleMessage(msg);
    }
  });

  return sock;
}

async function handleMessage(msg) {
  if (!msg.message) return;
  if (msg.key.fromMe) return;

  const chatJid = msg.key.remoteJid;
  if (isJidGroup(chatJid)) return;

  const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
  const isFromMe = msg.key.fromMe;

  let content = '';
  let isVoice = false;

  const m = msg.message;

  if (m.conversation) {
    content = m.conversation;
  } else if (m.extendedTextMessage?.text) {
    content = m.extendedTextMessage.text;
  } else if (m.imageMessage?.caption) {
    content = `[Gambar] ${m.imageMessage.caption}`;
  } else if (m.videoMessage?.caption) {
    content = `[Video] ${m.videoMessage.caption}`;
  } else if (m.audioMessage) {
    isVoice = true;
    content = '[Voice Note]';
  } else if (m.stickerMessage) {
    content = '[Stiker]';
  } else {
    return;
  }

  if (isVoice) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      content = await transcribeAudio(buffer);
      console.log(`[STT] Transcribed: "${content}"`);
    } catch (err) {
      console.error('[STT] Failed to transcribe:', err.message);
      content = '[Voice Note - tidak bisa ditranskripsi]';
    }
  }

  saveMessage(chatJid, sender, content, false);
  console.log(`[MSG] ${sender}: ${content}`);

  debounce(chatJid, async () => {
    try {
      const reply = await chatWithAI(chatJid, content);
      saveMessage(chatJid, 'bot', reply, true);
      console.log(`[REPLY] ${chatJid}: ${reply}`);
      await sock.sendMessage(chatJid, { text: reply });

      const voiceFiles = getVoiceFiles();
      if (voiceFiles.length > 0) {
        const { getHistory, formatHistoryForAI } = await import('./db.js');
        const history = getHistory(chatJid, 20);
        const aiHistory = formatHistoryForAI(history);
        const voiceFile = await selectVoiceFile(aiHistory);
        if (voiceFile) {
          const voicePath = getVoicePath(voiceFile);
          const audioBuffer = fs.readFileSync(voicePath);
          await sock.sendMessage(chatJid, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: true,
          });
          console.log(`[VOICE] Sent: ${voiceFile}`);
        }
      }
    } catch (err) {
      console.error('[AI] Error:', err.message);
      await sock.sendMessage(chatJid, { text: 'Maaf, ada gangguan. Coba lagi nanti.' });
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
  } catch (err) {
    console.error('[LOGOUT] Failed to clear database:', err.message);
  }

  clearLatestQr();
  emit('status', { connected: false, user: null });

  return true;
}
