import 'dotenv/config';

const getNum = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const SETTING_KEYS = [
  'DB_FILE',
  'TG_SESSION_FILE',
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_BASE_URL_STT',
  'AI_MODEL_STT',
  'MAX_HISTORY',
  'DEBOUNCE_MS',
  'EXTRA_PROMPT',
  'AI_SYSTEM_PROMPT',
  'AI_VOICE_SELECT_PROMPT',
  'PORT',
  'AUTO_REPLY_ENABLED',
  'MAX_FILE_MB',
  'AI_VISION_ENABLED',
  'AUTO_CATEGORIZE_ENABLED',
  'CATEGORY_MIN_CONFIDENCE',
  'CATEGORY_PROMPT',
  'WA_LABEL_SYNC_ENABLED',
];

// Semua pengaturan yang berkaitan dengan prompt disimpan di SQLite (bukan .env) agar teks multi-baris utuh.
export const PROMPT_KEYS = ['EXTRA_PROMPT', 'AI_SYSTEM_PROMPT', 'AI_VOICE_SELECT_PROMPT', 'CATEGORY_PROMPT'];

const NUMERIC_KEYS = ['MAX_HISTORY', 'DEBOUNCE_MS', 'PORT', 'MAX_FILE_MB', 'CATEGORY_MIN_CONFIDENCE'];
const BOOLEAN_KEYS = ['AUTO_REPLY_ENABLED', 'AI_VISION_ENABLED', 'AUTO_CATEGORIZE_ENABLED', 'WA_LABEL_SYNC_ENABLED'];

const DEFAULTS = {
  DB_FILE: 'data.sqlite3',
  TG_SESSION_FILE: 'session.key',
  AI_BASE_URL: 'http://localhost:20128/v1/chat/completions',
  AI_API_KEY: '',
  AI_MODEL: 'ag/gemini-3.6-flash-medium',
  AI_BASE_URL_STT: '',
  AI_MODEL_STT: 'whisper-1',
  MAX_HISTORY: '70',
  DEBOUNCE_MS: '8000',
  EXTRA_PROMPT: '',
  AI_SYSTEM_PROMPT: 'Kamu adalah asisten WhatsApp yang ramah dan helpful. Jawab dalam bahasa Indonesia dengan singkat dan jelas.',
  AI_VOICE_SELECT_PROMPT: '',
  PORT: '3000',
  AUTO_REPLY_ENABLED: 'true',
  MAX_FILE_MB: '50',               // lampiran lebih besar tidak diunduh (tetap dibalas)
  AI_VISION_ENABLED: 'false',      // kirim gambar ke AI (model harus mendukung gambar)
  AUTO_CATEGORIZE_ENABLED: 'true', // AI memasukkan customer ke kategori otomatis
  CATEGORY_MIN_CONFIDENCE: '60',   // 0-100, di bawah ini AI tidak memindahkan kategori
  CATEGORY_PROMPT: '',             // instruksi tambahan untuk pengklasifikasi
  WA_LABEL_SYNC_ENABLED: 'true',   // kategori = Label WhatsApp (Business); dua arah
};

export const config = {};

export function refreshConfig() {
  for (const key of SETTING_KEYS) {
    const raw = process.env[key] !== undefined ? process.env[key] : DEFAULTS[key];
    if (NUMERIC_KEYS.includes(key)) {
      config[key] = getNum(raw, parseInt(DEFAULTS[key], 10));
    } else if (BOOLEAN_KEYS.includes(key)) {
      const v = String(raw).trim().toLowerCase();
      config[key] = v === '1' || v === 'true' || v === 'yes' || v === 'on';
    } else {
      config[key] = raw;
    }
  }
}

refreshConfig();

export function applyEnvOverrides(overrides) {
  for (const key of Object.keys(overrides)) {
    if (SETTING_KEYS.includes(key)) {
      process.env[key] = String(overrides[key]);
    }
  }
  refreshConfig();
}