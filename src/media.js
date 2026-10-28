import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import pino from 'pino';
import { downloadMediaMessage, normalizeMessageContent } from '@whiskeysockets/baileys';
import { config } from './config.js';

export const UPLOAD_DIR = path.resolve('uploads');

// Dipisah agar bisa diganti saat pengujian (tanpa koneksi WhatsApp sungguhan).
export const hooks = { download: downloadMediaMessage };

const silentLogger = pino({ level: 'silent' });

/* ------------------------------------------------------------------ */
/*  1. Mengenali isi pesan masuk                                       */
/* ------------------------------------------------------------------ */

// Pesan sistem/teknis yang memang bukan pesan dari customer — tidak dibalas.
const IGNORED_TYPES = new Set([
  'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo',
  'reactionMessage', 'encReactionMessage', 'pollUpdateMessage', 'keepInChatMessage',
  'pinInChatMessage', 'editedMessage', 'albumMessage', 'associatedChildMessage',
  'peerDataOperationRequestMessage', 'peerDataOperationRequestResponseMessage',
  'botInvokeMessage', 'secretEncryptedMessage', 'stickerSyncRmrMessage',
]);

const MEDIA_KEYS = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

const num = (v) => {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function vcardInfo(vcard = '') {
  const name = (/^FN[;:](?:[^:\r\n]*:)?(.+)$/im.exec(vcard) || [])[1]?.trim() || '';
  const phones = [...vcard.matchAll(/^(?:item\d+\.)?TEL[^:\r\n]*:(.+)$/gim)].map(m => m[1].trim());
  return { name, phones };
}

function fmtBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/**
 * Terjemahkan pesan Baileys menjadi teks yang bisa dipahami AI + info lampiran.
 * Mengembalikan null untuk pesan teknis yang tidak perlu dibalas.
 *
 * Hasil: { kind, content, caption, media: { type, mime, name, size } | null }
 *  - kind: 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'contact' | 'location' | 'poll' | 'other'
 */
export function describeIncoming(msg) {
  const raw = msg?.message;
  if (!raw) return null;
  if (raw.editedMessage || raw.protocolMessage) return null; // edit/hapus pesan: bukan pesan baru

  const m = normalizeMessageContent(raw);
  if (!m) return null;

  const keys = Object.keys(m).filter(k => m[k] != null && k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage');
  if (!keys.length) return null;

  // --- teks biasa
  if (m.conversation) return { kind: 'text', content: m.conversation, media: null };
  if (m.extendedTextMessage?.text) return { kind: 'text', content: m.extendedTextMessage.text, media: null };

  // --- balasan tombol / daftar pilihan
  const reply = m.buttonsResponseMessage?.selectedDisplayText
    || m.templateButtonReplyMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || (() => {
      try { return JSON.parse(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}').title; } catch { return ''; }
    })();
  if (reply) return { kind: 'text', content: reply, media: null };

  // --- media (gambar, video, audio, dokumen, stiker)
  for (const key of Object.keys(MEDIA_KEYS)) {
    const node = m[key];
    if (!node) continue;
    let type = MEDIA_KEYS[key];
    const caption = (node.caption || '').trim();
    const size = num(node.fileLength);
    let mime = node.mimetype || '';
    let name = node.fileName || '';
    let label;

    if (type === 'image') label = '[Gambar]';
    else if (type === 'video') label = node.gifPlayback ? '[GIF]' : '[Video]';
    else if (type === 'sticker') label = '[Stiker]';
    else if (type === 'audio') { label = node.ptt ? '[Voice Note]' : '[Audio]'; }
    else {
      label = `[Dokumen: ${name || 'tanpa nama'}]`;
    }
    const kind = type === 'audio' ? (node.ptt ? 'voice' : 'audio') : type;
    const content = caption ? `${label} ${caption}` : label;
    return { kind, content, caption, media: { type, mime, name, size } };
  }

  // --- kontak
  if (m.contactMessage) {
    const v = vcardInfo(m.contactMessage.vcard);
    const name = m.contactMessage.displayName || v.name || 'tanpa nama';
    return { kind: 'contact', content: `[Kontak] ${name}${v.phones.length ? ' — ' + v.phones.join(', ') : ''}`, media: null };
  }
  if (m.contactsArrayMessage) {
    const list = (m.contactsArrayMessage.contacts || []).map((c) => {
      const v = vcardInfo(c.vcard);
      return `${c.displayName || v.name || 'tanpa nama'}${v.phones.length ? ' (' + v.phones.join(', ') + ')' : ''}`;
    });
    return { kind: 'contact', content: `[Kontak] ${list.join('; ') || 'tanpa data'}`, media: null };
  }

  // --- lokasi
  const loc = m.locationMessage || m.liveLocationMessage;
  if (loc) {
    const parts = [loc.name, loc.address].filter(Boolean).join(', ');
    const coord = (loc.degreesLatitude != null) ? `${loc.degreesLatitude}, ${loc.degreesLongitude}` : '';
    return { kind: 'location', content: `[Lokasi${m.liveLocationMessage ? ' langsung' : ''}] ${[parts, coord].filter(Boolean).join(' · ')}`.trim(), media: null };
  }

  // --- polling
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) {
    const opts = (poll.options || []).map(o => o.optionName).filter(Boolean).join(' / ');
    return { kind: 'poll', content: `[Polling] ${poll.name || ''}${opts ? ': ' + opts : ''}`.trim(), media: null };
  }

  // --- jenis lain yang tidak dikenal: tetap diterima, jangan diabaikan
  const other = keys.find(k => !IGNORED_TYPES.has(k));
  if (!other) return null;
  const nice = other.replace(/Message(V\d+)?$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return { kind: 'other', content: `[Lampiran: ${nice || other}]`, media: null };
}

/* ------------------------------------------------------------------ */
/*  2. Mengunduh & menyimpan lampiran                                  */
/* ------------------------------------------------------------------ */

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt', 'text/csv': '.csv',
  'application/json': '.json',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

function baseMime(mime) { return String(mime || '').split(';')[0].trim().toLowerCase(); }

export function safeFileName(name, mime, fallbackStem = 'file') {
  let base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = fallbackStem;
  if (base.length > 100) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 100 - ext.length) + ext;
  }
  if (!path.extname(base)) base += EXT_BY_MIME[baseMime(mime)] || '';
  return base;
}

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.log', '.yml', '.yaml',
  '.ini', '.sql', '.js', '.ts', '.py', '.css', '.vcf', '.ics', '.srt', '.rtf']);

function isTextLike(mime, name) {
  const m = baseMime(mime);
  return m.startsWith('text/') || /json|xml|csv|yaml|javascript/.test(m) || TEXT_EXT.has(path.extname(name || '').toLowerCase());
}

function extractText(file, mime, name) {
  try {
    if (!isTextLike(mime, name)) return '';
    const st = fs.statSync(file);
    if (!st.size || st.size > 1024 * 1024) return '';
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 24000));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.includes(0)) return ''; // biner
    return buf.toString('utf8').replace(/\r\n/g, '\n').trim().slice(0, 6000);
  } catch { return ''; }
}

/**
 * Unduh lampiran ke folder uploads/. Tidak pernah melempar error:
 * kegagalan dikembalikan sebagai { path: null, error } agar bot tetap membalas.
 */
export async function storeMedia(msg, info, { sock } = {}) {
  const m = info.media;
  const maxBytes = Math.max(1, config.MAX_FILE_MB) * 1024 * 1024;
  const base = {
    type: m.type, mime: m.mime, size: m.size,
    name: safeFileName(m.name, m.mime, `${m.type}-${String(msg.key?.id || Date.now()).slice(-8)}`),
    path: null, text: '',
  };

  if (m.size && m.size > maxBytes) {
    return { ...base, error: `Ukuran ${fmtBytes(m.size)} melebihi batas ${config.MAX_FILE_MB} MB, tidak diunduh` };
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const stored = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${base.name}`;
  const target = path.join(UPLOAD_DIR, stored);

  try {
    const stream = await hooks.download(msg, 'stream', {}, {
      logger: silentLogger,
      reuploadRequest: sock?.updateMediaMessage ? sock.updateMediaMessage : async (x) => x,
    });
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new Error(`Melebihi batas ${config.MAX_FILE_MB} MB`));
        cb(null, chunk);
      },
    });
    await pipeline(stream, limiter, fs.createWriteStream(target));
    if (!bytes) throw new Error('File kosong');
    return { ...base, path: stored, size: bytes, text: extractText(target, m.mime, base.name) };
  } catch (err) {
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
    return { ...base, error: err?.message || String(err) };
  }
}

/* ------------------------------------------------------------------ */
/*  3. Akses file (dashboard) & pembersihan                            */
/* ------------------------------------------------------------------ */

export function mediaFilePath(stored) {
  const safe = path.basename(String(stored || ''));
  if (!safe || safe !== stored) return null;
  const p = path.join(UPLOAD_DIR, safe);
  return fs.existsSync(p) ? p : null;
}

/** Hanya tipe yang aman ditampilkan langsung di browser; sisanya selalu diunduh. */
export function isInlineSafe(mime) {
  return /^(image\/(jpeg|png|gif|webp)|audio\/(ogg|mpeg|mp4|aac|wav|webm)|video\/(mp4|webm|3gpp|quicktime))$/.test(baseMime(mime));
}

export function deleteMediaFiles(storedNames = []) {
  for (const n of storedNames) {
    const p = mediaFilePath(n);
    if (p) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
  }
}

export function clearAllMedia() {
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Untuk AI vision: gambar kecil sebagai data URL. */
export function imageDataUrl(stored, mime) {
  try {
    const p = mediaFilePath(stored);
    const mt = baseMime(mime);
    if (!p || !/^image\/(jpeg|png|webp|gif)$/.test(mt)) return null;
    if (fs.statSync(p).size > 4 * 1024 * 1024) return null;
    return `data:${mt};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch { return null; }
}
