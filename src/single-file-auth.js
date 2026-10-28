import fs from 'fs';
import path from 'path';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

const KEY_MAP = {
  'pre-key': 'preKeys',
  session: 'sessions',
  'sender-key': 'senderKeys',
  'app-state-sync-key': 'appStateSyncKeys',
  'app-state-sync-version': 'appStateVersions',
  'trusted-key': 'trustedKeys',
};

export function useSingleFileAuthState(filename) {
  const file = path.resolve(filename);

  let creds;
  let keys = {};

  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw, BufferJSON.reviver);
      creds = parsed?.creds || null;
      keys = parsed?.keys && typeof parsed.keys === 'object' ? parsed.keys : {};
      if (creds && creds.registrationId) {
        console.log(`[AUTH] Loaded session from ${filename}`);
      } else {
        creds = null;
        keys = {};
      }
    } catch (err) {
      console.warn(`[AUTH] Failed to load ${filename}, starting fresh:`, err.message);
      creds = null;
      keys = {};
    }
  }

  if (!creds || !creds.registrationId) {
    creds = initAuthCreds();
    keys = {};
    console.log(`[AUTH] New pairing. Initialized fresh credentials in memory (${filename}).`);
  }

  let saveTimer = null;
  const saveState = (immediate = false) => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const doSave = () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        const data = JSON.stringify({
          creds,
          keys,
        }, BufferJSON.replacer, 2);
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, file);
      } catch (err) {
        console.error('[AUTH] Failed to save session:', err.message);
      }
    };
    if (immediate) {
      doSave();
    } else {
      saveTimer = setTimeout(doSave, 250);
    }
  };

  const clearState = () => {
    try {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {}
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const key = KEY_MAP[type];
          if (!key) return {};
          const store = keys[key] || {};
          const data = {};
          if (!Array.isArray(ids)) return data;
          for (const id of ids) {
            if (typeof id === 'string' && store[id] !== undefined) {
              data[id] = store[id];
            }
          }
          return data;
        },
        set: async (data) => {
          if (!data || typeof data !== 'object') return;
          let changed = false;
          for (const type in data) {
            const key = KEY_MAP[type];
            if (!key) continue;
            if (!keys[key]) {
              keys[key] = {};
            }
            const entries = data[type] || {};
            for (const id in entries) {
              if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
              keys[key][id] = entries[id];
              changed = true;
            }
          }
          if (changed) {
            saveState(false);
          }
        },
        clear: async () => {
          keys = {};
          saveState(true);
        },
      },
    },
    saveCreds: () => {
      saveState(true);
    },
    clearState,
  };
}