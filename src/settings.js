import fs from 'fs';
import path from 'path';
import { config, SETTING_KEYS, PROMPT_KEYS, applyEnvOverrides } from './config.js';
import { getAppSetting, setAppSetting } from './db.js';

const ENV_FILE = path.resolve('.env');

/**
 * Muat prompt dari database ke konfigurasi. Database menang atas .env.
 * Nilai di .env hanya dipakai sekali sebagai data awal (disalin ke database bila belum ada).
 */
export function loadPromptSettings() {
  const overrides = {};
  for (const key of PROMPT_KEYS) {
    const stored = getAppSetting(key);
    if (stored !== null) { overrides[key] = stored; continue; }
    let envVal = process.env[key];
    if (typeof envVal === 'string' && envVal.trim() !== '') {
      // Di .env tanpa tanda kutip, baris baru ditulis literal "\n"; kembalikan jadi baris baru sungguhan.
      if (!envVal.includes('\n')) envVal = envVal.replace(/\\n/g, '\n');
      setAppSetting(key, envVal);
      overrides[key] = envVal;
      console.log(`[SETTINGS] ${key} disalin dari .env ke database`);
    }
  }
  if (Object.keys(overrides).length) applyEnvOverrides(overrides);
}

export function getSettings() {
  return {
    DB_FILE: config.DB_FILE,
    TG_SESSION_FILE: config.TG_SESSION_FILE,
    AI_BASE_URL: config.AI_BASE_URL,
    AI_MODEL: config.AI_MODEL,
    AI_BASE_URL_STT: config.AI_BASE_URL_STT,
    AI_MODEL_STT: config.AI_MODEL_STT,
    MAX_HISTORY: String(config.MAX_HISTORY),
    DEBOUNCE_MS: String(config.DEBOUNCE_MS),
    EXTRA_PROMPT: config.EXTRA_PROMPT,
    AI_SYSTEM_PROMPT: config.AI_SYSTEM_PROMPT,
    AUTO_REPLY_ENABLED: !!config.AUTO_REPLY_ENABLED,
    MAX_FILE_MB: String(config.MAX_FILE_MB),
    AI_VISION_ENABLED: !!config.AI_VISION_ENABLED,
    AUTO_CATEGORIZE_ENABLED: !!config.AUTO_CATEGORIZE_ENABLED,
    CATEGORY_MIN_CONFIDENCE: String(config.CATEGORY_MIN_CONFIDENCE),
    CATEGORY_PROMPT: config.CATEGORY_PROMPT,
    WA_LABEL_SYNC_ENABLED: !!config.WA_LABEL_SYNC_ENABLED,
    AI_API_KEY_MASKED: maskKey(config.AI_API_KEY),
    HAS_API_KEY: !!config.AI_API_KEY,
  };
}

export function updateSettings(payload) {
  const editable = SETTING_KEYS.filter(k => k !== 'PORT');
  const overrides = {};
  const result = { updated: [] };

  for (const key of editable) {
    if (!(key in payload)) continue;
    let value = payload[key];
    if (typeof value !== 'string') {
      value = String(value == null ? '' : value);
    }
    value = value.trim();
    if (value === '') {
      overrides[key] = value;
    } else {
      overrides[key] = value;
    }
    result.updated.push(key);
  }

  if (Object.keys(overrides).length === 0) {
    result.noChanges = true;
    return result;
  }

  // Prompt -> database; sisanya -> .env
  const envChanges = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (PROMPT_KEYS.includes(k)) setAppSetting(k, v);
    else envChanges[k] = v;
  }
  if (Object.keys(envChanges).length) writeEnvFile(envChanges);
  applyEnvOverrides(overrides);

  return { ...result, note: 'Prompt tersimpan di database. Pengaturan DB/SESSION baru aktif setelah restart.' };
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '*'.repeat(key.length);
  return key.slice(0, 3) + '*'.repeat(Math.max(4, key.length - 6)) + key.slice(-3);
}

function writeEnvFile(changes) {
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  }
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const out = [];
  const used = new Set();

  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m && SETTING_KEYS.includes(m[1])) {
      const key = m[1];
      let value;
      if (key in changes) {
        value = changes[key];
      } else {
        value = line.slice(line.indexOf('=') + 1).trim();
      }
      out.push(`${key}=${escapeEnvValue(value)}`);
      used.add(key);
    } else {
      out.push(line);
    }
  }

  for (const key of Object.keys(changes)) {
    if (!used.has(key)) {
      out.push(`${key}=${escapeEnvValue(changes[key])}`);
    }
  }

  fs.writeFileSync(ENV_FILE, out.join('\n').replace(/^\n+/, '') + '\n');
}

function escapeEnvValue(value) {
  if (value.includes('\n')) {
    return '"' + value.replace(/\r?\n/g, '\\n') + '"';
  }
  return value;
}