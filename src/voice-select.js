import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { callChat } from './ai-client.js';

const VOICE_DIR = path.resolve('voice-notes');

const DEFAULT_PROMPT = `Berdasarkan riwayat percakapan di atas, pilih SATU nama file suara yang paling pas dan nyambung dari daftar di bawah ini:
DAFTAR FILE:
{FILE_LIST}
ATURAN:
1. Jawab HANYA nama file persis dari daftar (contoh: halo-sayang.mp3).
2. Jangan tambahkan penjelasan, alasan, atau teks lain.
3. Jika tidak ada yang cocok, tetap pilih SATU file dari daftar.`;

export function getVoiceFiles() {
  if (!fs.existsSync(VOICE_DIR)) {
    try {
      fs.mkdirSync(VOICE_DIR, { recursive: true });
    } catch {}
    return [];
  }
  try {
    return fs.readdirSync(VOICE_DIR).filter(f => /\.(mp3|ogg|wav|m4a|opus)$/i.test(f));
  } catch {
    return [];
  }
}

export async function selectVoiceFile(chatHistory) {
  const files = getVoiceFiles();
  if (files.length === 0) return null;

  const fileList = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const promptTemplate = config.AI_VOICE_SELECT_PROMPT || DEFAULT_PROMPT;
  const prompt = promptTemplate.replace('{FILE_LIST}', fileList);

  const historySlice = Array.isArray(chatHistory) ? chatHistory.slice(-12) : [];
  const messages = [
    ...historySlice,
    { role: 'user', content: prompt },
  ];

  try {
    const { text } = await callChat({
      model: config.AI_MODEL,
      messages,
      stream: false,
      max_tokens: 30,
      temperature: 0,
    }, { timeoutMs: 20000, retries: 1 });

    const chosen = text.toString().trim();
    const matched = files.find(f => chosen === f || chosen.includes(f));
    return matched || files[Math.floor(Math.random() * files.length)];
  } catch (err) {
    console.warn('[VOICE] Pemilihan AI gagal, pakai file acak:', err.message);
    return files[Math.floor(Math.random() * files.length)];
  }
}

export function getVoicePath(filename) {
  return path.join(VOICE_DIR, filename);
}

/* ---------- Manajemen file voice note (untuk dashboard) ---------- */

const AUDIO_RE = /\.(mp3|ogg|wav|m4a|opus)$/i;
const MIME = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg; codecs=opus',
  '.opus': 'audio/ogg; codecs=opus',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

export function getVoiceMime(filename) {
  return MIME[path.extname(filename).toLowerCase()] || 'audio/mpeg';
}

export function sanitizeVoiceName(name) {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!base || base.startsWith('.') || !AUDIO_RE.test(base)) return null;
  return base;
}

export function getVoiceDetails() {
  return getVoiceFiles().map((name) => {
    try {
      const st = fs.statSync(path.join(VOICE_DIR, name));
      return { name, size: st.size, modified: st.mtimeMs };
    } catch {
      return { name, size: 0, modified: 0 };
    }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function saveVoiceFile(name, buffer) {
  const safe = sanitizeVoiceName(name);
  if (!safe) throw new Error('Nama/format file tidak valid (gunakan mp3, ogg, wav, m4a, opus)');
  if (!buffer || !buffer.length) throw new Error('File kosong');
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  let target = safe;
  const ext = path.extname(safe);
  const stem = safe.slice(0, -ext.length);
  let i = 1;
  while (fs.existsSync(path.join(VOICE_DIR, target))) target = `${stem}-${i++}${ext}`;
  fs.writeFileSync(path.join(VOICE_DIR, target), buffer);
  return target;
}

export function deleteVoiceFile(name) {
  const safe = sanitizeVoiceName(name);
  if (!safe) throw new Error('Nama file tidak valid');
  const p = path.join(VOICE_DIR, safe);
  if (!fs.existsSync(p)) throw new Error('File tidak ditemukan');
  fs.unlinkSync(p);
  return safe;
}
