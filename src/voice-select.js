import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { config } from './config.js';

const VOICE_DIR = path.resolve('voice-notes');

const DEFAULT_PROMPT = `Berdasarkan riwayat percakapan di atas, pilih SATU nama file suara yang paling pas dan nyambung dari daftar di bawah ini:
DAFTAR FILE:
{FILE_LIST}
ATURAN:
1. Jawab HANYA nama file dari daftar (contoh: halo-sayang.mp3).
2. Tanpa teks lain.`;

export function getVoiceFiles() {
  if (!fs.existsSync(VOICE_DIR)) {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    return [];
  }
  return fs.readdirSync(VOICE_DIR).filter(f => /\.(mp3|ogg|wav|m4a|opus)$/i.test(f));
}

export async function selectVoiceFile(chatHistory) {
  const files = getVoiceFiles();
  if (files.length === 0) return null;

  const fileList = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const promptTemplate = config.AI_VOICE_SELECT_PROMPT || DEFAULT_PROMPT;
  const prompt = promptTemplate.replace('{FILE_LIST}', fileList);

  const messages = [
    ...chatHistory.slice(-10),
    { role: 'user', content: prompt },
  ];

  const res = await fetch(config.AI_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.AI_API_KEY ? { Authorization: `Bearer ${config.AI_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: config.AI_MODEL,
      messages,
      max_tokens: 50,
    }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const chosen = data.choices?.[0]?.message?.content?.trim() || '';

  const matched = files.find(f => chosen.includes(f));
  if (!matched) return files[Math.floor(Math.random() * files.length)];

  return matched;
}

export function getVoicePath(filename) {
  return path.join(VOICE_DIR, filename);
}
