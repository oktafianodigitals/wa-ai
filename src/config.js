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
];

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
};

export const config = {};

export function refreshConfig() {
  for (const key of SETTING_KEYS) {
    const raw = process.env[key] !== undefined ? process.env[key] : DEFAULTS[key];
    if (key === 'MAX_HISTORY' || key === 'DEBOUNCE_MS' || key === 'PORT') {
      config[key] = getNum(raw, parseInt(DEFAULTS[key], 10));
    } else if (key === 'AUTO_REPLY_ENABLED') {
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