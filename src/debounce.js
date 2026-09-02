import { config } from './config.js';

const timers = new Map();

export function debounce(chatJid, callback) {
  if (timers.has(chatJid)) {
    clearTimeout(timers.get(chatJid));
  }

  const timer = setTimeout(() => {
    timers.delete(chatJid);
    callback();
  }, config.DEBOUNCE_MS);

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