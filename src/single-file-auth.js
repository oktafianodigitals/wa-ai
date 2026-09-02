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

const KEY_MAP_REV = {};
for (const k in KEY_MAP) KEY_MAP_REV[KEY_MAP[k]] = k;

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
      if (creds) {
        console.log(`[AUTH] Loaded session from ${filename}`);
      }
    } catch (err) {
      console.warn(`[AUTH] Failed to load ${filename}, starting fresh:`, err.message);
      creds = null;
    }
  }

  if (!creds || !creds.registrationId) {
    creds = initAuthCreds();
    console.log(`[AUTH] New pairing. Initialized fresh credentials in memory (${filename}).`);
  }

  const saveState = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        creds,
        keys,
      }, BufferJSON.replacer, 2));
    } catch (err) {
      console.error('[AUTH] Failed to save session:', err.message);
    }
  };

  const clearState = () => {
    try {
      fs.unlinkSync(file);
    } catch {}
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const key = KEY_MAP[type];
          const store = keys[key] || {};
          const data = {};
          for (const id of ids) {
            if (typeof id === 'string' && store[id]) {
              data[id] = store[id];
            }
          }
          return data;
        },
        set: async (data) => {
          for (const type in data) {
            const key = KEY_MAP[type];
            if (!key) continue;
            if (!keys[key]) keys[key] = {};
            const entries = data[type] || {};
            for (const id in entries) {
              if (id === '__proto__' || id === 'constructor') continue;
              keys[key][id] = entries[id];
            }
          }
        },
        clear: async () => {
          keys = {};
        },
      },
    },
    saveCreds: () => {
      saveState();
    },
    clearState,
  };
}