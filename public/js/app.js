/* WA-AI dashboard — vanilla JS, tanpa dependensi selain socket.io client */
'use strict';

const SETTING_FIELDS = [
  'DB_FILE', 'TG_SESSION_FILE', 'AUTO_REPLY_ENABLED',
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_BASE_URL_STT', 'AI_MODEL_STT',
  'MAX_HISTORY', 'DEBOUNCE_MS',
  'EXTRA_PROMPT', 'AI_SYSTEM_PROMPT',
  'MAX_FILE_MB', 'AI_VISION_ENABLED', 'AUTO_CATEGORIZE_ENABLED', 'CATEGORY_MIN_CONFIDENCE', 'CATEGORY_PROMPT', 'WA_LABEL_SYNC_ENABLED',
];
const BOOL_FIELDS = ['AUTO_REPLY_ENABLED', 'AI_VISION_ENABLED', 'AUTO_CATEGORIZE_ENABLED', 'WA_LABEL_SYNC_ENABLED'];

const PAGES = {
  dashboard: { title: 'Dashboard', subtitle: 'Kondisi bot dan jalur koneksinya saat ini' },
  chats: { title: 'Chat', subtitle: 'Riwayat percakapan dan balasan manual' },
  categories: { title: 'Kategori', subtitle: 'Label WhatsApp sebagai kategori; AI memasang label yang tepat otomatis' },
  settings: { title: 'Pengaturan', subtitle: 'Koneksi AI, perilaku balasan, dan sistem' },
};

const state = {
  page: 'dashboard',
  connected: false,
  chats: [],
  activeJid: null,
  ai: null,
  autoReply: true,
  settingsDirty: false,
  unread: 0,
  categories: [],
  catSync: null,
  catFilter: 'all',   // 'all' | 'none' | id kategori
  convoCat: null,
};

let socket = null;
let socketConnected = false;
let latestQr = null;

const $ = (id) => document.getElementById(id);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------------- Util ---------------- */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, type = 'success') {
  const box = $('toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, type === 'error' ? 5000 : 2600);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, options);
  let data = null;
  try { data = await res.json(); } catch { /* bukan JSON */ }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    err.hint = data && data.hint;
    throw err;
  }
  return data;
}

const postJson = (path, body, method = 'POST') => api(path, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

function icon(name) { return `<svg class="ic"><use href="#i-${name}"/></svg>`; }

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* Kontak: nama, nomor, foto profil */
const contactMap = new Map();

function rememberContact(jid, row) {
  if (!jid || !row) return;
  const prev = contactMap.get(jid) || {};
  contactMap.set(jid, {
    name: row.contact_name ?? row.name ?? prev.name ?? '',
    phone: row.contact_phone ?? row.phone ?? prev.phone ?? '',
    pic: (row.pic_ok ?? (prev.pic ? 1 : 0)) ? (row.pic_version || prev.pic || 1) : 0,
  });
}

function parseJid(jid) {
  const [local = '', domain = ''] = String(jid).split('@');
  const c = contactMap.get(jid) || {};
  const digits = c.phone || (domain === 's.whatsapp.net' ? local.split(':')[0].replace(/\D/g, '') : '');
  const phone = digits ? '+' + digits : '';
  const idLabel = domain === 'lid' ? 'Kontak ' + local.slice(-5) : (local || jid);
  const name = c.name || phone || idLabel;
  let sub;
  if (c.name && phone) sub = phone;
  else if (phone) sub = 'Nomor WhatsApp';
  else sub = domain === 'lid' ? `Nomor disembunyikan oleh WhatsApp · ID ${local}` : jid;
  const base = c.name || digits || local;
  const letters = c.name ? [...c.name.replace(/[^\p{L}\p{N}]/gu, '')][0] : '';
  return { name, sub, phone, hasName: !!c.name, pic: c.pic || 0, initials: (letters || base.slice(-2) || '?').toUpperCase() };
}

const AVATAR_COLORS = ['#2f6f9f', '#7a5aa6', '#b5651d', '#2e8b78', '#a8476a', '#5b7a2f', '#3f5fa8', '#9a5b3c'];
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarHtml(jid, cls = '', id = '') {
  const p = parseJid(jid);
  const img = p.pic ? `<img src="/api/avatar/${encodeURIComponent(jid)}?v=${p.pic}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="avatar ${cls}" ${id ? `id="${id}"` : ''} style="background:${avatarColor(jid)}"><span>${esc(p.initials)}</span>${img}</div>`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
}
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ts) {
  const now = Date.now();
  if (dayKey(ts) === dayKey(now)) return 'Hari ini';
  if (dayKey(ts) === dayKey(now - 864e5)) return 'Kemarin';
  return new Date(ts).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return `${mins} mnt`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'kemarin' : `${days} hari`;
}
function listTime(ts) {
  if (!ts) return '';
  return dayKey(ts) === dayKey(Date.now()) ? fmtTime(ts) : timeAgo(ts);
}
function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

/* ---------------- Navigasi ---------------- */
function navigateTo(page) {
  if (!PAGES[page]) return;
  state.page = page;
  qsa('.nav-item, .tab').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  qsa('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
  $('page-title').textContent = PAGES[page].title;
  $('page-subtitle').textContent = PAGES[page].subtitle;

  if (page === 'dashboard') { loadStats(); loadRecent(); loadAiStatus(); }
  if (page === 'chats') { setUnread(0); loadChats(); }
  if (page === 'categories') loadCategories();
  if (page === 'settings') { if (!state.settingsDirty) loadSettings(); loadLogs(); }
}

function initNavigation() {
  qsa('.nav-item, .tab').forEach((el) => el.addEventListener('click', () => navigateTo(el.dataset.page)));
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) navigateTo(g.dataset.goto);
  });
  $('refresh-btn').addEventListener('click', refreshAll);
}

function setUnread(n) {
  state.unread = n;
  const b = $('nav-chat-badge');
  b.hidden = n <= 0;
  b.textContent = n > 99 ? '99+' : String(n);
}

/* ---------------- Login / status WA ---------------- */
function switchToLogin() { $('login-screen').style.display = 'grid'; $('app-shell').hidden = true; }
function switchToApp() {
  $('login-screen').style.display = 'none';
  const shell = $('app-shell');
  const first = shell.hidden;
  shell.hidden = false;
  if (first) { loadStats(); loadRecent(); loadCategories(); loadChats(); loadAiStatus(); loadSettings(); }
}

function setLoginStatus(text, isError = false) {
  const el = $('login-status');
  el.textContent = text || '';
  el.className = 'login-status' + (isError ? ' error' : '');
}

function showQR(dataUrl) {
  latestQr = dataUrl;
  const img = $('qr-image');
  const loading = $('qr-loading');
  if (!dataUrl) {
    img.removeAttribute('src');
    loading.hidden = false;
    setLoginStatus(socketConnected ? 'Menunggu kode QR dari WhatsApp…' : 'Menghubungkan ke server…');
    return;
  }
  img.src = dataUrl;
  loading.hidden = true;
  setLoginStatus('Pindai kode QR ini dengan WhatsApp di ponsel');
}

function setStatus(connected, user) {
  state.connected = connected;
  $('status-dot').className = 'dot ' + (connected ? 'online' : 'offline');
  $('status-text').textContent = connected ? 'WhatsApp terhubung' : 'Belum tertaut';
  const name = user ? (user.name || (user.id ? String(user.id).split(/[:@]/)[0] : '')) : '';
  $('user-info').textContent = connected ? name : '';
  if (connected) switchToApp(); else switchToLogin();
  renderLinkstrip();
}

/* ---------------- Dashboard ---------------- */
async function loadStats() {
  try {
    const d = await api('/db/stats');
    $('stat-messages').textContent = d.totalMessages ?? '–';
    $('stat-chats').textContent = d.totalChats ?? '–';
    $('stat-today').textContent = d.today ?? '–';
    $('stat-bot').textContent = d.botReplies ?? '–';
    renderChart(d.daily || []);
  } catch { /* biarkan nilai lama */ }
}

function renderChart(daily) {
  const el = $('chart');
  if (!daily.length) { el.innerHTML = ''; return; }
  const max = Math.max(1, ...daily.flatMap((d) => [d.incoming, d.bot]));
  const todayKey = dayKey(Date.now());
  el.innerHTML = daily.map((d) => {
    const hIn = (d.incoming / max) * 100;
    const hBot = (d.bot / max) * 100;
    const label = new Date(d.date).toLocaleDateString('id-ID', { weekday: 'short' });
    const bar = (cls, n, h) => `<div class="bar ${cls}" style="height:${n ? Math.max(h, 3) : 1}%" title="${n}">${n ? `<span class="bar-val">${n}</span>` : ''}</div>`;
    return `<div class="bar-col ${dayKey(d.date) === todayKey ? 'today' : ''}">
      <div class="bar-stack">${bar('in', d.incoming, hIn)}${bar('bot', d.bot, hBot)}</div>
      <div class="bar-label">${esc(label)}</div></div>`;
  }).join('');
  el.setAttribute('aria-label', 'Pesan masuk dan balasan bot 7 hari terakhir: ' +
    daily.map((d) => `${new Date(d.date).toLocaleDateString('id-ID', { weekday: 'long' })} ${d.incoming} masuk, ${d.bot} balasan`).join('; '));
}

async function loadRecent() {
  const ul = $('recent-list');
  try {
    const { messages } = await api('/recent');
    messages.forEach((m) => rememberContact(m.chat_jid, m));
    if (!messages.length) {
      ul.innerHTML = '<li class="empty" style="cursor:default"><div><strong>Belum ada aktivitas</strong>Pesan masuk dan balasan bot akan tampil di sini.</div></li>';
      return;
    }
    ul.innerHTML = messages.map((m) => {
      const p = parseJid(m.chat_jid);
      const tag = m.is_from_bot ? `<span class="recent-tag">${m.sender === 'manual' ? 'manual' : 'bot'}</span>` : '';
      return `<li data-jid="${esc(m.chat_jid)}">${avatarHtml(m.chat_jid, 'sm')}
        <div class="recent-main"><div class="recent-top"><span class="recent-who">${esc(p.name)}</span>${tag}</div>
        <div class="recent-text">${esc(m.content)}</div></div>
        <div class="recent-time">${esc(timeAgo(m.timestamp))}</div></li>`;
    }).join('');
  } catch {
    ul.innerHTML = '<li class="empty">Gagal memuat aktivitas.</li>';
  }
}

document.addEventListener('click', (e) => {
  const li = e.target.closest('#recent-list li[data-jid]');
  if (li) openChat(li.dataset.jid);
});

/* Status AI + jalur koneksi */
async function loadAiStatus() {
  try {
    state.ai = await api('/ai/status');
  } catch (err) {
    state.ai = { reachable: false, error: err.message, enabled: state.autoReply };
  }
  state.autoReply = !!state.ai.enabled;
  renderLinkstrip();
}

function setNode(id, st, detail) {
  $(id).dataset.state = st;
  $(id + '-detail').textContent = detail;
  $(id + '-detail').title = detail;
}

function renderLinkstrip() {
  const ai = state.ai;
  const wa = state.connected;
  setNode('node-wa', wa ? 'ok' : 'bad', wa ? ($('user-info').textContent || 'Terhubung') : 'Belum tertaut');

  const botSt = ai ? (ai.enabled ? 'ok' : 'warn') : 'idle';
  setNode('node-bot', botSt, ai ? (ai.enabled ? 'Aktif, chat pribadi' : 'Dimatikan') : 'Memeriksa…');

  let rSt = 'idle'; let rTxt = 'Memeriksa…';
  let mSt = 'idle'; let mTxt = '–';
  if (ai) {
    if (!ai.reachable) { rSt = 'bad'; rTxt = /ECONNREFUSED/.test(ai.error || '') ? 'Tidak berjalan' : 'Tidak terjangkau'; mTxt = 'Menunggu 9router'; }
    else if (ai.authProblem) { rSt = 'warn'; rTxt = 'API key ditolak'; mTxt = 'Butuh API key'; }
    else { rSt = 'ok'; rTxt = `Terhubung · ${ai.latency} ms`; }
    if (rSt === 'ok') {
      if (ai.modelAvailable === false) { mSt = 'warn'; mTxt = `"${ai.model}" tidak ditemukan`; }
      else { mSt = 'ok'; mTxt = ai.model || '–'; }
    }
  }
  setNode('node-router', rSt, rTxt);
  setNode('node-model', mSt, mTxt);

  const wire = (id, a, b) => {
    const sa = $(a).dataset.state; const sb = $(b).dataset.state;
    $(id).dataset.state = (sa === 'ok' && sb === 'ok') ? 'ok' : (sb === 'bad' || sa === 'bad') ? 'bad' : 'idle';
  };
  wire('wire-1', 'node-wa', 'node-bot');
  wire('wire-2', 'node-bot', 'node-router');
  wire('wire-3', 'node-router', 'node-model');

  // Panel kanan
  $('ai-model').textContent = ai?.model || '–';
  $('ai-baseurl').textContent = ai?.baseUrl || '–';
  $('ai-apikey').textContent = ai ? (ai.hasKey ? 'Tersimpan' : 'Belum diisi') : '–';
  const toggle = $('auto-reply-toggle');
  toggle.checked = !!(ai ? ai.enabled : state.autoReply);
  state.autoReply = toggle.checked; renderConvoBot(); renderChatList();
  $('auto-reply-status').textContent = toggle.checked ? 'Aktif' : 'Dimatikan';

  // Banner
  const alert = $('ai-alert');
  if (ai && (!ai.reachable || ai.authProblem || ai.modelAvailable === false)) {
    alert.hidden = false;
    alert.classList.toggle('warn', !!ai.reachable);
    $('ai-alert-title').textContent = !ai.reachable ? 'Bot belum bisa menghubungi AI'
      : ai.authProblem ? 'API key ditolak oleh 9router'
        : 'Model tidak ada di 9router';
    $('ai-alert-hint').textContent = !ai.reachable ? [ai.error, ai.hint].filter(Boolean).join('. ')
      : ai.authProblem ? ai.hint
        : `Ganti model di Pengaturan. Tersedia: ${(ai.models || []).slice(0, 4).join(', ')}${(ai.models || []).length > 4 ? ', …' : ''}`;
  } else {
    alert.hidden = true;
  }
}

async function toggleAutoReply(checked) {
  $('auto-reply-status').textContent = 'Menyimpan…';
  try {
    await postJson('/settings', { AUTO_REPLY_ENABLED: checked ? 'true' : 'false' });
    toast(checked ? 'Balas otomatis aktif' : 'Balas otomatis dimatikan');
    state.settingsDirty = false;
    await loadAiStatus();
    loadSettings();
  } catch (err) {
    toast('Gagal mengubah balas otomatis: ' + err.message, 'error');
    $('auto-reply-toggle').checked = !checked;
    $('auto-reply-status').textContent = !checked ? 'Aktif' : 'Dimatikan';
  }
}

/* ---------------- Chat ---------------- */
async function loadChats() {
  try {
    const d = await api('/chats');
    state.chats = Array.isArray(d.chats) ? d.chats : [];
    state.chats.forEach((c) => rememberContact(c.chat_jid, c));
    renderChatList();
  } catch {
    $('chat-list').innerHTML = '<div class="empty"><strong>Gagal memuat chat</strong>Coba segarkan halaman.</div>';
  }
}

/* Penanda bot di daftar chat: BOT = membalas, MANUAL = tidak membalas (dimatikan untuk chat ini atau global). */
function botBadge(c) {
  const chatOn = c.bot_enabled !== 0 && c.bot_enabled !== false;
  const on = chatOn && state.autoReply;
  const why = on ? 'Bot sedang membalas chat ini'
    : !chatOn ? 'Balas otomatis dimatikan untuk chat ini' : 'Balas otomatis global sedang dimatikan';
  return `<span class="bot-badge ${on ? 'on' : 'off'}" title="${why}">${on ? 'BOT' : 'MANUAL'}</span>`;
}

function catPill(name, color) {
  return name ? `<span class="cat-pill" style="--c:${esc(color || '#2f6f9f')}">${esc(name)}</span>` : '';
}

function renderCatFilter() {
  const bar = $('cat-filter');
  if (!state.categories.length) { bar.hidden = true; if (state.catFilter !== 'all') state.catFilter = 'all'; return; }
  bar.hidden = false;
  const count = (fn) => state.chats.filter(fn).length;
  const chips = [
    { key: 'all', label: 'Semua', n: state.chats.length },
    ...state.categories.map((c) => ({ key: String(c.id), label: c.name, color: c.color, n: count((x) => x.category_id === c.id) })),
    { key: 'none', label: 'Tanpa kategori', n: count((x) => !x.category_id) },
  ];
  if (!chips.some((c) => c.key === String(state.catFilter))) state.catFilter = 'all';
  bar.innerHTML = chips.map((c) => `<button type="button" class="chip ${String(state.catFilter) === c.key ? 'active' : ''}" data-cat="${esc(c.key)}"${c.color ? ` style="--c:${esc(c.color)}"` : ''}>${c.color ? '<i></i>' : ''}${esc(c.label)}<b>${c.n}</b></button>`).join('');
}

function renderChatList() {
  const q = $('chat-search').value.trim().toLowerCase();
  renderCatFilter();
  let list = q
    ? state.chats.filter((c) => (c.chat_jid + ' ' + parseJid(c.chat_jid).name + ' ' + parseJid(c.chat_jid).phone + ' ' + (c.last_message || '') + ' ' + (c.category_name || '')).toLowerCase().includes(q))
    : state.chats;
  if (state.catFilter === 'none') list = list.filter((c) => !c.category_id);
  else if (state.catFilter !== 'all') list = list.filter((c) => String(c.category_id) === String(state.catFilter));
  const box = $('chat-list');
  if (!list.length) {
    box.innerHTML = (q || state.catFilter !== 'all')
      ? '<div class="empty"><strong>Tidak ada hasil</strong>Coba kata kunci atau filter lain.</div>'
      : '<div class="empty"><strong>Belum ada percakapan</strong>Kirim pesan ke nomor ini dari WhatsApp lain untuk mencoba.</div>';
    return;
  }
  box.innerHTML = list.map((c) => {
    const p = parseJid(c.chat_jid);
    return `<div class="chat-row ${c.chat_jid === state.activeJid ? 'active' : ''}" data-jid="${esc(c.chat_jid)}" role="option" tabindex="0">
      ${avatarHtml(c.chat_jid)}
      <div class="chat-row-main">
        <div class="chat-row-top"><span class="chat-row-name">${esc(p.name)}</span>${botBadge(c)}<span class="chat-row-time">${esc(listTime(c.last_time))}</span></div>
        <div class="chat-row-last">${catPill(c.category_name, c.category_color)}${esc(c.last_message || '(tanpa pesan)')}</div>
      </div>
      <button class="icon-btn row-clear" type="button" aria-label="Bersihkan chat ${esc(p.name)}" title="Bersihkan chat">${icon('trash')}</button></div>`;
  }).join('');
}

function openChat(jid) {
  state.activeJid = jid;
  state.convoCat = null; state.msgSig = null;
  renderConvoCategory();
  navigateTo('chats');
  $('chat-shell').classList.add('show-convo');
  $('convo-empty').hidden = true;
  $('convo').hidden = false;
  updateConvoHeader(jid);
  api('/contacts/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jid }) })
    .then(() => setTimeout(() => { loadChats(); if (state.activeJid === jid) loadConversation(); }, 5000)).catch(() => {});
  renderChatList();
  loadConversation(true);
  setTimeout(() => { if (window.matchMedia('(min-width: 801px)').matches) $('composer-input').focus(); }, 50);
}

async function clearConversation(jid) {
  const p = parseJid(jid);
  if (!confirm(`Bersihkan percakapan dengan ${p.name}?\n\nSeluruh riwayat chat ini dihapus dari database dan AI mulai dari nol pada pesan berikutnya. Pesan di aplikasi WhatsApp tidak ikut terhapus.`)) return;
  try {
    const r = await api('/chats/' + encodeURIComponent(jid), { method: 'DELETE' });
    toast(`Percakapan dibersihkan (${r.deleted} pesan dihapus)`);
    if (state.activeJid === jid) closeConvo();
    loadChats(); loadStats(); loadRecent();
  } catch (err) { toast('Gagal membersihkan: ' + err.message, 'error'); }
}

function updateConvoHeader(jid) {
  const p = parseJid(jid);
  $('convo-avatar').outerHTML = avatarHtml(jid, '', 'convo-avatar');
  $('convo-name').textContent = p.name;
  $('convo-sub').textContent = p.sub;
}

function renderConvoBot() {
  const t = $('convo-bot-toggle'); if (!t) return;
  const chatOn = state.convoBot !== false;
  t.checked = chatOn;
  const el = $('convo-bot');
  const paused = !chatOn || !state.autoReply;
  el.classList.toggle('paused', paused);
  $('convo-bot-status').textContent = !chatOn ? 'Mati untuk chat ini'
    : !state.autoReply ? 'Aktif, tapi global mati' : 'Bot membalas chat ini';
  el.title = !state.autoReply && chatOn ? 'Balas otomatis global sedang dimatikan (Dashboard/Pengaturan)' : 'Bot membalas chat ini secara otomatis';
}

async function toggleConvoBot(checked) {
  const jid = state.activeJid; if (!jid) return;
  state.convoBot = checked; renderConvoBot();
  try {
    await postJson('/chats/' + encodeURIComponent(jid) + '/bot', { enabled: checked }, 'PUT');
    toast(checked ? 'Bot akan membalas chat ini' : 'Bot berhenti membalas chat ini');
    loadChats();
  } catch (err) {
    toast('Gagal: ' + err.message, 'error');
    state.convoBot = !checked; renderConvoBot();
  }
}

function closeConvo() {
  state.activeJid = null;
  $('chat-shell').classList.remove('show-convo');
  $('convo').hidden = true;
  $('convo-empty').hidden = false;
  renderChatList();
}

async function loadConversation(forceBottom = false) {
  const jid = state.activeJid;
  if (!jid) return;
  const box = $('messages');
  if (forceBottom) box.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const d = await api('/history/' + encodeURIComponent(jid) + '?limit=200');
    if (state.activeJid !== jid) return;
    if (d.contact) { rememberContact(jid, d.contact); updateConvoHeader(jid); }
    state.convoCat = d.category || null;
    state.convoBot = d.bot_enabled !== false;
    renderConvoCategory();
    renderConvoBot();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    // Render ulang hanya bila pesan berubah, agar video/audio yang sedang diputar tidak terputus.
    const sig = jid + '|' + (d.messages || []).map((m) => m.id).join(',');
    if (forceBottom || sig !== state.msgSig) {
      renderMessages(d.messages || []);
      state.msgSig = sig;
      if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
    }
  } catch (err) {
    box.innerHTML = `<div class="empty"><strong>Gagal memuat riwayat</strong>${esc(err.message)}</div>`;
  }
}

function renderMessages(msgs) {
  const box = $('messages');
  if (!msgs.length) { box.innerHTML = '<div class="empty"><strong>Belum ada pesan</strong>Tulis balasan di bawah untuk memulai.</div>'; return; }
  let lastDay = ''; let lastDir = '';
  box.innerHTML = msgs.map((m) => {
    const dir = m.is_from_bot ? 'out' : 'in';
    let html = '';
    const dk = dayKey(m.timestamp);
    if (dk !== lastDay) { html += `<div class="day-divider">${esc(dayLabel(m.timestamp))}</div>`; lastDay = dk; lastDir = ''; }
    const who = m.is_from_bot ? (m.sender === 'manual' ? '<div class="who manual">Kamu (manual)</div>' : '<div class="who">Bot</div>') : '';
    const showWho = m.is_from_bot && (lastDir !== 'out' || m.sender === 'manual');
    const isVoice = !m.media && (m.content === '[Voice Note]' || m.content.startsWith('[Voice Note'));
    let body;
    if (m.media) {
      const text = m.content.replace(/^\[[^\]]*\]\s*/, '').trim();
      body = attachmentHtml(m) + (text ? `<div class="att-text">${esc(text)}</div>` : '');
    } else {
      body = isVoice ? `<span class="tag-voice">${icon('mic')}${esc(m.content.replace(/^\[|\]$/g, ''))}</span>` : esc(m.content);
    }
    html += `<div class="msg ${dir} ${lastDir !== dir ? 'gap' : ''}"><div class="bubble">${showWho ? who : ''}${body}<div class="bubble-meta">${esc(fmtTime(m.timestamp))}</div></div></div>`;
    lastDir = dir;
    return html;
  }).join('');
}

/* Lampiran di gelembung chat */
const INLINE_RE = /^(image\/(jpeg|png|gif|webp)|audio\/(ogg|mpeg|mp4|aac|wav|webm)|video\/(mp4|webm|3gpp|quicktime))$/;
function attachmentHtml(m) {
  const a = m.media;
  const label = esc(a.name || 'File');
  if (!a.available) {
    return `<div class="att-file off">${icon('file')}<div class="att-info"><b>${label}</b><span>${a.size ? fmtSize(a.size) + ' · ' : ''}tidak tersimpan (terlalu besar / gagal diunduh)</span></div></div>`;
  }
  const url = `/api/media/${m.id}`;
  const inline = INLINE_RE.test(String(a.mime || '').split(';')[0].trim().toLowerCase());
  if (inline && a.type === 'image') return `<a class="att-media" href="${url}" target="_blank" rel="noopener"><img class="att-img" src="${url}" alt="${label}" loading="lazy"></a>`;
  if (inline && a.type === 'sticker') return `<img class="att-sticker" src="${url}" alt="Stiker" loading="lazy">`;
  if (inline && a.type === 'video') return `<video class="att-video" src="${url}" controls preload="metadata"></video>`;
  if (inline && a.type === 'audio') return `<audio class="att-audio" src="${url}" controls preload="none"></audio>`;
  return `<a class="att-file" href="${url}?download=1" download>${icon('file')}<div class="att-info"><b>${label}</b><span>${a.size ? fmtSize(a.size) : 'File'}${a.mime ? ' · ' + esc(String(a.mime).split(';')[0]) : ''}</span></div>${icon('download')}</a>`;
}

/* ---------------- Kategori ---------------- */
async function loadCategories() {
  try {
    const d = await api('/categories');
    state.categories = d.categories || [];
    state.catSync = d.sync || null;
  } catch { /* biarkan data lama */ }
  renderCategoryList();
  renderCatFilter();
  renderConvoCategory();
}

function fmtAgo(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'baru saja' : m < 60 ? `${m} menit lalu` : `${Math.round(m / 60)} jam lalu`;
}

function renderSyncStatus() {
  const el = $('cat-sync-status'); if (!el) return;
  const sy = state.catSync;
  const btn = $('cat-sync');
  if (btn) btn.disabled = !!sy?.syncing || !state.connected;
  if (!sy) { el.textContent = ''; return; }
  const waCount = state.categories.filter((c) => c.wa_label_id).length;
  let msg;
  if (!sy.enabled) msg = 'Sinkron Label WhatsApp dimatikan di Pengaturan.';
  else if (!state.connected) msg = 'WhatsApp belum terhubung; label akan dibaca setelah terhubung.';
  else if (sy.syncing) msg = 'Membaca label dari WhatsApp…';
  else if (sy.lastError && !waCount) msg = sy.lastError;
  else if (waCount) msg = `${waCount} label tersinkron dari WhatsApp${sy.lastSyncAt ? ` · ${fmtAgo(sy.lastSyncAt)}` : ''}.`;
  else msg = 'Belum ada label terbaca. Pastikan memakai WhatsApp Business dan sudah membuat label (Alat bisnis → Label). Bila labelnya sudah ada, klik "Sinkronkan label WhatsApp"; bila tetap kosong, keluar lalu scan QR ulang agar kunci sinkronisasi dikirim WhatsApp.';
  el.textContent = msg;
  el.classList.toggle('warn', !!state.connected && sy.enabled && !sy.syncing && !waCount);
}

function renderCategoryList() {
  const ul = $('cat-list');
  $('cat-count').textContent = state.categories.length ? `(${state.categories.length})` : '';
  renderSyncStatus();
  if (!state.categories.length) {
    ul.innerHTML = `<li class="empty" style="cursor:default"><strong>Belum ada kategori</strong>Kategori muncul otomatis dari Label WhatsApp Business. Buat labelnya di aplikasi WhatsApp, lalu klik "Sinkronkan label WhatsApp".</li>`;
    return;
  }
  ul.innerHTML = state.categories.map((c) => `
    <li class="cat-item" data-id="${c.id}" style="--c:${esc(c.color)}">
      <span class="cat-swatch"></span>
      <div class="cat-main">
        <div class="cat-name">${esc(c.name)}${c.wa_label_id ? '' : ' <span class="cat-badge" title="Tidak ada di WhatsApp; hanya lokal. AI hanya memakai label WhatsApp bila ada.">lokal</span>'}</div>
        <div class="cat-desc">${c.description ? esc(c.description) : '<em>Tanpa kriteria — AI menilai dari namanya saja</em>'}</div>
      </div>
      <button class="btn sm ghost cat-members" type="button" title="Lihat customer di kategori ini">${c.total} customer</button>
      <button class="icon-btn cat-edit" type="button" aria-label="Ubah kriteria ${esc(c.name)}" title="Ubah kriteria">${icon('edit')}</button>
      ${c.wa_label_id ? '' : `<button class="icon-btn cat-del" type="button" aria-label="Hapus ${esc(c.name)}" title="Hapus">${icon('trash')}</button>`}
    </li>`).join('');
}

let editingCat = null;
function openCatForm(cat) {
  if (!cat) return;
  editingCat = cat.id;
  $('cat-form').hidden = false;
  $('cat-name').value = cat.name;
  $('cat-name').disabled = !!cat.wa_label_id; // nama label diatur di WhatsApp
  $('cat-desc').value = cat.description || '';
  $('cat-save').textContent = 'Simpan perubahan';
  $('cat-desc').focus();
}
function closeCatForm() { $('cat-form').hidden = true; editingCat = null; }

async function saveCategory(e) {
  e.preventDefault();
  if (!editingCat) return;
  const body = { description: $('cat-desc').value.trim() };
  const cur = state.categories.find((c) => c.id === editingCat);
  if (cur && !cur.wa_label_id) body.name = $('cat-name').value.trim();
  const btn = $('cat-save'); btn.disabled = true;
  try {
    await postJson('/categories/' + editingCat, body, 'PUT');
    toast('Kriteria diperbarui');
    closeCatForm();
    await loadCategories(); loadChats();
  } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
}

async function syncLabels() {
  const btn = $('cat-sync'); btn.disabled = true;
  state.catSync = { ...(state.catSync || {}), syncing: true }; renderSyncStatus();
  try {
    const r = await postJson('/categories/sync');
    state.categories = r.categories || state.categories; state.catSync = r.sync || state.catSync;
    toast(`${state.categories.filter((c) => c.wa_label_id).length} label tersinkron dari WhatsApp`);
  } catch (err) { toast('Sinkron gagal: ' + err.message, 'error'); }
  await loadCategories(); loadChats();
}

async function deleteCategory(id) {
  const c = state.categories.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`Hapus kategori "${c.name}"?${c.total ? `\n\n${c.total} customer akan dilepas dari kategori ini (chat-nya tidak terhapus).` : ''}`)) return;
  try {
    await api('/categories/' + id, { method: 'DELETE' });
    if (String(state.catFilter) === String(id)) state.catFilter = 'all';
    toast('Kategori dihapus');
    await loadCategories(); loadChats();
  } catch (err) { toast('Gagal menghapus: ' + err.message, 'error'); }
}

async function classifyAllChats() {
  if (!state.categories.length) { toast('Belum ada label. Buat label di WhatsApp Business lalu sinkronkan.', 'error'); return; }
  if (!confirm('AI akan membaca ulang semua percakapan, menetapkan kategorinya, dan memasang labelnya di WhatsApp (kecuali yang kamu tetapkan manual). Proses berjalan di latar belakang dan memakai panggilan AI sebanyak jumlah chat. Lanjutkan?')) return;
  try {
    const r = await postJson('/categories/classify-all');
    toast(r.started ? `Mengelompokkan ${r.queued} chat di latar belakang…` : `Belum bisa dimulai: ${r.reason}`, r.started ? 'success' : 'error');
    if (r.started) { setTimeout(() => { loadCategories(); loadChats(); }, 6000); }
  } catch (err) { toast(err.message, 'error'); }
}

/* Pemilih kategori di dalam percakapan */
function renderConvoCategory() {
  const sel = $('convo-category');
  if (!sel) return;
  const cur = state.convoCat;
  sel.innerHTML = '<option value="">Belum ada / otomatis oleh AI</option>' +
    state.categories.map((c) => `<option value="${c.id}" ${cur && cur.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  if (!cur) sel.value = '';
  $('convo-cat').classList.toggle('has-cat', !!cur);
  $('convo-cat').style.setProperty('--c', cur?.color || 'var(--line-2)');
  let info = '';
  if (!state.categories.length) info = 'Belum ada label — sinkronkan di menu Kategori';
  else if (cur) {
    info = cur.by === 'manual' ? 'Ditetapkan manual — AI tidak mengubahnya'
      : cur.by === 'wa' ? 'Label dari WhatsApp'
      : `Oleh AI${cur.confidence != null ? ` (${cur.confidence}%)` : ''}${cur.reason ? ` · ${cur.reason}` : ''}`;
  }
  $('convo-cat-info').textContent = info;
  $('convo-cat-info').title = info;
  sel.disabled = !state.categories.length;
  $('convo-categorize').disabled = !state.categories.length;
}

async function setConvoCategory(value) {
  const jid = state.activeJid; if (!jid) return;
  try {
    await postJson('/chats/' + encodeURIComponent(jid) + '/category', { category_id: value ? Number(value) : null }, 'PUT');
    toast(value ? 'Kategori ditetapkan manual' : 'Kategori dilepas; AI akan menilai lagi pada pesan berikutnya');
    await loadConversation(); loadChats(); loadCategories();
  } catch (err) { toast('Gagal: ' + err.message, 'error'); await loadConversation(); }
}

async function categorizeConvo() {
  const jid = state.activeJid; if (!jid) return;
  const btn = $('convo-categorize'); btn.disabled = true;
  $('convo-cat-info').textContent = 'AI sedang membaca percakapan…';
  try {
    const r = await postJson('/chats/' + encodeURIComponent(jid) + '/categorize');
    if (r.applied) toast(`Dikategorikan: ${r.category} (${r.confidence}%)`);
    else if (r.skipped === 'undecided') toast('AI belum bisa memutuskan' + (r.reason ? `: ${r.reason}` : ''), 'error');
    else if (r.skipped === 'low-confidence') toast(`AI condong ke "${r.category}" tetapi hanya ${r.confidence}% yakin (di bawah ambang minimum di Pengaturan). Tetapkan manual bila perlu.`, 'error');
    else if (r.skipped === 'no-categories') toast('Belum ada label. Sinkronkan label WhatsApp di menu Kategori', 'error');
    else toast(r.error || 'Tidak ada perubahan', r.error ? 'error' : 'success');
  } catch (err) { toast('Gagal: ' + err.message, 'error'); }
  btn.disabled = false;
  await loadConversation(); loadChats(); loadCategories();
}

function initCategories() {
  $('cat-sync').addEventListener('click', syncLabels);
  $('cat-cancel').addEventListener('click', closeCatForm);
  $('cat-form').addEventListener('submit', saveCategory);
  $('cat-classify-all').addEventListener('click', classifyAllChats);
  $('cat-list').addEventListener('click', async (e) => {
    const li = e.target.closest('.cat-item'); if (!li) return;
    const id = Number(li.dataset.id);
    if (e.target.closest('.cat-edit')) openCatForm(state.categories.find((c) => c.id === id));
    else if (e.target.closest('.cat-del')) deleteCategory(id);
    else if (e.target.closest('.cat-members')) { state.catFilter = String(id); closeConvo(); navigateTo('chats'); }
  });
  $('cat-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    state.catFilter = chip.dataset.cat; renderChatList();
  });
  $('convo-bot-toggle').addEventListener('change', (e) => toggleConvoBot(e.target.checked));
  $('convo-category').addEventListener('change', (e) => setConvoCategory(e.target.value));
  $('convo-categorize').addEventListener('click', categorizeConvo);
}

async function sendFromComposer(e) {
  e.preventDefault();
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !state.activeJid) return;
  const btn = $('composer-send');
  btn.disabled = true;
  try {
    await postJson('/send', { jid: state.activeJid, text });
    input.value = '';
    autoGrow(input);
    await loadConversation(true);
    loadChats();
  } catch (err) {
    toast('Pesan belum terkirim: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; }

function initChat() {
  $('chat-search').addEventListener('input', debounce(renderChatList, 120));
  $('chat-list').addEventListener('click', (e) => {
    const row = e.target.closest('.chat-row');
    if (!row) return;
    if (e.target.closest('.row-clear')) clearConversation(row.dataset.jid);
    else openChat(row.dataset.jid);
  });
  $('chat-list').addEventListener('keydown', (e) => {
    const row = e.target.closest('.chat-row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openChat(row.dataset.jid); }
  });
  $('convo-clear').addEventListener('click', () => state.activeJid && clearConversation(state.activeJid));
  $('convo-back').addEventListener('click', closeConvo);
  $('convo-reload').addEventListener('click', () => loadConversation(true));
  $('composer').addEventListener('submit', sendFromComposer);
  const input = $('composer-input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
}

/* ---------------- Pengaturan ---------------- */
async function loadSettings() {
  try {
    const d = await api('/settings');
    for (const key of SETTING_FIELDS) {
      const el = $('set-' + key);
      if (!el) continue;
      if (BOOL_FIELDS.includes(key)) { el.value = d[key] ? 'true' : 'false'; continue; }
      el.value = d[key] ?? '';
    }
    const keyEl = $('set-AI_API_KEY');
    keyEl.value = '';
    keyEl.placeholder = d.HAS_API_KEY ? 'Tersimpan. Kosongkan untuk mempertahankan' : 'Belum diisi. Tempel API key dari 9router';
    state.settingsDirty = false;
    setSaveMsg('');
  } catch {
    toast('Gagal memuat pengaturan', 'error');
  }
}

function setSaveMsg(text, cls = '') {
  const el = $('settings-result');
  el.textContent = text;
  el.className = 'savebar-msg ' + cls;
}

async function saveSettings(e) {
  e.preventDefault();
  const btn = $('settings-btn');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  const payload = {};
  for (const key of SETTING_FIELDS) {
    const el = $('set-' + key);
    if (el) payload[key] = el.value.trim();
  }
  if (payload.AI_API_KEY === '') delete payload.AI_API_KEY;
  try {
    const d = await postJson('/settings', payload);
    setSaveMsg('Tersimpan' + (d.note ? `. ${d.note}` : ''), 'ok');
    toast('Pengaturan tersimpan');
    state.settingsDirty = false;
    await loadSettings();
    setSaveMsg('Tersimpan' + (d.note ? `. ${d.note}` : ''), 'ok');
    loadAiStatus();
  } catch (err) {
    setSaveMsg('Gagal menyimpan: ' + err.message, 'error');
    toast('Gagal menyimpan pengaturan', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan pengaturan';
  }
}

function formAiOverrides() {
  return {
    baseUrl: $('set-AI_BASE_URL').value.trim(),
    apiKey: $('set-AI_API_KEY').value.trim(),
    model: $('set-AI_MODEL').value.trim(),
  };
}

function renderDiag(steps, summary) {
  const ol = $('diag');
  ol.hidden = false;
  ol.innerHTML = steps.map((s) => {
    const cls = s.pending ? 'wait' : s.ok ? 'ok' : 'fail';
    const mark = s.pending ? '<span class="spinner"></span>' : icon(s.ok ? 'check' : 'x');
    return `<li class="${cls}"><span class="mark">${mark}</span><div>
      <div class="diag-name">${esc(s.name)}</div>
      ${s.detail ? `<div class="diag-detail">${esc(s.detail)}</div>` : ''}
      ${s.hint && !s.ok ? `<div class="diag-hint">${esc(s.hint)}</div>` : ''}</div></li>`;
  }).join('') + (summary ? `<li class="diag-summary ${summary.ok ? 'ok' : 'fail'}" style="display:block">${esc(summary.text)}</li>` : '');
}

async function runDiagnosis() {
  const btn = $('test-btn');
  btn.disabled = true;
  renderDiag([{ name: 'Menguji koneksi ke AI…', pending: true }]);
  try {
    const r = await postJson('/ai/test', formAiOverrides());
    renderDiag(r.steps || [], r.ok
      ? { ok: true, text: `Terhubung. AI membalas dalam ${r.ms} ms.` }
      : { ok: false, text: r.error || 'Koneksi gagal' });
    if (r.models?.length) fillModels(r.models);
  } catch (err) {
    renderDiag([{ name: 'Menghubungi dashboard', ok: false, detail: err.message }], { ok: false, text: 'Tes tidak dapat dijalankan' });
  } finally {
    btn.disabled = false;
    loadAiStatus();
  }
}

function fillModels(models) {
  $('model-options').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

async function fetchModels() {
  const btn = $('models-btn');
  btn.disabled = true;
  try {
    const { models } = await postJson('/ai/models', formAiOverrides());
    fillModels(models);
    toast(models.length ? `${models.length} model ditemukan. Klik kolom Model untuk memilih.` : 'Server tidak mengembalikan daftar model');
    if (models.length) { $('set-AI_MODEL').focus(); }
  } catch (err) {
    toast(err.message + (err.hint ? `. ${err.hint}` : ''), 'error');
  } finally { btn.disabled = false; }
}

async function loadLogs() {
  const el = $('app-logs');
  try {
    const res = await fetch('/api/logs');
    el.textContent = (await res.text()) || '(Belum ada log)';
    el.scrollTop = el.scrollHeight;
  } catch (err) { el.textContent = 'Gagal memuat log: ' + err.message; }
}

function initSettings() {
  $('settings-form').addEventListener('submit', saveSettings);
  $('settings-form').addEventListener('input', () => { state.settingsDirty = true; setSaveMsg('Ada perubahan yang belum disimpan'); });
  $('settings-reload').addEventListener('click', () => { loadSettings(); $('diag').hidden = true; });
  $('test-btn').addEventListener('click', runDiagnosis);
  $('models-btn').addEventListener('click', fetchModels);
  $('logs-reload').addEventListener('click', loadLogs);
  $('logs-clear').addEventListener('click', async () => {
    try { await api('/logs/clear', { method: 'POST' }); toast('Log dibersihkan'); loadLogs(); } catch { toast('Gagal membersihkan log', 'error'); }
  });
  $('auto-reply-toggle').addEventListener('change', (e) => toggleAutoReply(e.target.checked));
  const goTest = async () => { navigateTo('settings'); await loadSettings(); runDiagnosis(); $('test-btn').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  $('dash-test-btn').addEventListener('click', goTest);
  $('ai-alert-test').addEventListener('click', goTest);
}

/* ---------------- Logout & refresh ---------------- */
async function logout() {
  if (!confirm('Keluar dari WhatsApp? Sesi login dan seluruh riwayat chat di database akan dihapus.')) return;
  const btn = $('logout-btn');
  btn.disabled = true;
  try {
    await postJson('/logout');
    toast('Sesi dihapus. Pindai QR baru untuk masuk lagi.');
    state.chats = []; state.activeJid = null;
    showQR(null); setStatus(false, null); closeConvo(); renderChatList();
  } catch (err) { toast('Gagal keluar: ' + err.message, 'error'); } finally { btn.disabled = false; }
}

function refreshAll() {
  loadStats(); loadRecent(); loadCategories(); loadChats(); loadAiStatus();
  if (state.page === 'settings') loadLogs();
  if (state.activeJid) loadConversation();
  toast('Data diperbarui');
}

/* ---------------- Socket ---------------- */
const refreshSoon = debounce(() => {
  loadChats();
  if (state.page === 'categories') loadCategories();
  if (state.page === 'dashboard') { loadStats(); loadRecent(); }
  if (state.activeJid) loadConversation();
}, 300);

function initSocket() {
  socket = io();
  socket.on('qr', (d) => showQR(d));
  socket.on('status', (d) => {
    setStatus(!!d?.connected, d?.user || null);
    if (!d?.connected) socket.emit('qr-request');
  });
  socket.on('chat-updated', (d) => {
    if (!(state.page === 'chats' && d?.jid === state.activeJid) && state.page !== 'chats') setUnread(state.unread + 1);
    refreshSoon();
  });
  socket.on('categories-updated', () => { loadCategories(); });
  socket.on('connect', () => { socketConnected = true; socket.emit('status-request'); socket.emit('qr-request'); });
  socket.on('disconnect', () => {
    socketConnected = false;
    setStatus(false, null); showQR(null);
    setLoginStatus('Terputus dari server. Mencoba menyambung kembali…', true);
  });
}

/* ---------------- Boot ---------------- */
async function boot() {
  initNavigation(); initChat(); initCategories(); initSettings();
  $('logout-btn').addEventListener('click', logout);
  showQR(null);
  initSocket();
  try { const h = await api('/health'); $('version').textContent = 'v' + h.version; } catch { $('version').textContent = ''; }

  setInterval(() => {
    if (document.hidden || !socketConnected) return;
    if (!latestQr && !state.connected) socket.emit('qr-request');
    if (!state.connected) return;
    if (state.page === 'dashboard') { loadStats(); loadRecent(); }
  }, 10000);
  setInterval(() => { if (!document.hidden && state.connected) loadAiStatus(); }, 15000);
  setInterval(() => { if (!document.hidden && state.page === 'settings') loadLogs(); }, 10000);
}

boot();
