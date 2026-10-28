import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { getContact, upsertContact, setContactPicture, listChatJids } from './db.js';

const AVATAR_DIR = path.resolve('avatars');
const OK_TTL = 24 * 3600 * 1000;      // foto yang ada dicek ulang tiap 24 jam
const MISS_TTL = 6 * 3600 * 1000;     // chat tanpa foto/privat dicek ulang tiap 6 jam

const queue = [];
const queued = new Set();
let running = false;

export function avatarFile(jid) {
  return path.join(AVATAR_DIR, String(jid).replace(/[^a-z0-9]/gi, '_') + '.jpg');
}

/** Nomor telepon dari JID biasa; JID @lid tidak memuat nomor. */
export function phoneFromJid(jid) {
  const [local, domain] = String(jid).split('@');
  return domain === 's.whatsapp.net' ? local.split(':')[0].replace(/\D/g, '') : '';
}

/** Simpan nama (pushName) dan nomor yang bisa diketahui dari pesan masuk. */
export function rememberFromMessage(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return;
  const altPn = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJidAlt || '';
  const phone = phoneFromJid(jid) || phoneFromJid(String(altPn));
  upsertContact(jid, { name: msg.pushName, phone });
}

export function rememberContacts(list) {
  for (const c of list || []) {
    if (!c?.id || c.id.endsWith('@g.us')) continue;
    const name = c.name || c.notify || c.verifiedName;
    if (name || phoneFromJid(c.id)) upsertContact(c.id, { name, phone: phoneFromJid(c.id) });
  }
}

function isStale(jid, force) {
  if (force) return true;
  const c = getContact(jid);
  if (!c || !c.pic_checked) return true;
  return Date.now() - c.pic_checked > (c.pic_ok ? OK_TTL : MISS_TTL);
}

/** Antrekan pengambilan foto profil (berurutan agar tidak membanjiri server WhatsApp). */
export function queueAvatar(getSock, jid, { force = false } = {}) {
  if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) return;
  if (queued.has(jid) || !isStale(jid, force)) return;
  queued.add(jid);
  queue.push(jid);
  run(getSock);
}

export function queueAllAvatars(getSock) {
  try { listChatJids().forEach(j => queueAvatar(getSock, j)); } catch { /* db belum siap */ }
}

async function run(getSock) {
  if (running) return;
  running = true;
  while (queue.length) {
    const jid = queue.shift();
    queued.delete(jid);
    try { await fetchAvatar(getSock(), jid); } catch (err) {
      console.warn(`[CONTACT] Foto ${jid} gagal: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  running = false;
}

async function fetchAvatar(sock, jid) {
  if (!sock?.user) return;
  let url = null;
  try {
    url = await sock.profilePictureUrl(jid, 'image');
  } catch {
    url = null; // tidak ada foto, atau disembunyikan oleh pemilik
  }
  if (!url) { setContactPicture(jid, false); return; }
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) { setContactPicture(jid, false); return; }
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  fs.writeFileSync(avatarFile(jid), buf);
  setContactPicture(jid, true);
}

export function clearAvatars() {
  try { fs.rmSync(AVATAR_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}
