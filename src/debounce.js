import { config } from './config.js';

const timers = new Map();

export function debounce(chatJid, callback) {
  if (!chatJid) return;
  if (timers.has(chatJid)) {
    clearTimeout(timers.get(chatJid));
  }

  const delay = typeof config.DEBOUNCE_MS === 'number' && config.DEBOUNCE_MS >= 0 ? config.DEBOUNCE_MS : 8000;

  const timer = setTimeout(() => {
    timers.delete(chatJid);
    try {
      const result = callback();
      if (result && typeof result.catch === 'function') {
        result.catch(err => {
          console.error('[DEBOUNCE] callback error:', err.message);
        });
      }
    } catch (err) {
      console.error('[DEBOUNCE] callback error:', err.message);
    }
  }, delay);

  timers.set(chatJid, timer);
}

export function cancelDebounce(chatJid) {
  if (timers.has(chatJid)) {
    clearTimeout(timers.get(chatJid));
    timers.delete(chatJid);
    return true;
  }
  return false;
}

export function hasPending(chatJid) {
  return timers.has(chatJid);
}

export function clearAllDebounces() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}