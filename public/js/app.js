/* WA-AI dashboard — vanilla JS, tanpa dependensi selain socket.io client */
'use strict';

const SETTING_FIELDS = [
  'DB_FILE', 'TG_SESSION_FILE', 'AUTO_REPLY_ENABLED',
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_BASE_URL_STT', 'AI_MODEL_STT',
  'MAX_HISTORY', 'DEBOUNCE_MS',
  'EXTRA_PROMPT', 'AI_SYSTEM_PROMPT', 'AI_VOICE_SELECT_PROMPT',
];

const PAGES = {
  dashboard: { title: 'Dashboard', subtitle: 'Kondisi bot dan jalur koneksinya saat ini' },
  chats: { title: 'Chat', subtitle: 'Riwayat percakapan dan balasan manual' },
  voice: { title: 'Voice note', subtitle: 'Pustaka audio yang bisa dikirim bot' },
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
  voice: [],
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

/* Nama & avatar dari JID */
function parseJid(jid) {
  const [local = '', domain = ''] = String(jid).split('@');
  const digits = local.replace(/\D/g, '');
  if (domain === 's.whatsapp.net' && digits) {
    return { name: '+' + digits, sub: 'Nomor WhatsApp', initials: digits.slice(-2) };
  }
  if (domain === 'lid') {
    return { name: 'Kontak ' + local.slice(-5), sub: `ID tertaut ${local}`, initials: local.slice(-2) };
  }
  return { name: local || jid, sub: jid, initials: (local || '?').slice(0, 2).toUpperCase() };
}

const AVATAR_COLORS = ['#2f6f9f', '#7a5aa6', '#b5651d', '#2e8b78', '#a8476a', '#5b7a2f', '#3f5fa8', '#9a5b3c'];
function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarHtml(jid, cls = '') {
  const p = parseJid(jid);
  return `<div class="avatar ${cls}" style="background:${avatarColor(jid)}">${esc(p.initials)}</div>`;
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
  if (page === 'voice') loadVoiceFiles();
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
  if (first) { loadStats(); loadRecent(); loadChats(); loadAiStatus(); loadSettings(); }
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
    renderChatList();
  } catch {
    $('chat-list').innerHTML = '<div class="empty"><strong>Gagal memuat chat</strong>Coba segarkan halaman.</div>';
  }
}

function renderChatList() {
  const q = $('chat-search').value.trim().toLowerCase();
  const list = q
    ? state.chats.filter((c) => (c.chat_jid + ' ' + parseJid(c.chat_jid).name + ' ' + (c.last_message || '')).toLowerCase().includes(q))
    : state.chats;
  const box = $('chat-list');
  if (!list.length) {
    box.innerHTML = q
      ? '<div class="empty"><strong>Tidak ada hasil</strong>Coba kata kunci lain.</div>'
      : '<div class="empty"><strong>Belum ada percakapan</strong>Kirim pesan ke nomor ini dari WhatsApp lain untuk mencoba.</div>';
    return;
  }
  box.innerHTML = list.map((c) => {
    const p = parseJid(c.chat_jid);
    return `<button class="chat-row ${c.chat_jid === state.activeJid ? 'active' : ''}" data-jid="${esc(c.chat_jid)}" role="option">
      ${avatarHtml(c.chat_jid)}
      <div class="chat-row-main">
        <div class="chat-row-top"><span class="chat-row-name">${esc(p.name)}</span><span class="chat-row-time">${esc(listTime(c.last_time))}</span></div>
        <div class="chat-row-last">${esc(c.last_message || '(tanpa pesan)')}</div>
      </div></button>`;
  }).join('');
}

function openChat(jid) {
  state.activeJid = jid;
  navigateTo('chats');
  $('chat-shell').classList.add('show-convo');
  $('convo-empty').hidden = true;
  $('convo').hidden = false;
  const p = parseJid(jid);
  $('convo-avatar').outerHTML = `<div class="avatar" id="convo-avatar" style="background:${avatarColor(jid)}">${esc(p.initials)}</div>`;
  $('convo-name').textContent = p.name;
  $('convo-sub').textContent = p.sub;
  renderChatList();
  loadConversation(true);
  setTimeout(() => { if (window.matchMedia('(min-width: 801px)').matches) $('composer-input').focus(); }, 50);
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
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    renderMessages(d.messages || []);
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
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
    const isVoice = m.content === '[Voice Note]' || m.content.startsWith('[Voice Note');
    const body = isVoice ? `<span class="tag-voice">${icon('mic')}${esc(m.content.replace(/^\[|\]$/g, ''))}</span>` : esc(m.content);
    html += `<div class="msg ${dir} ${lastDir !== dir ? 'gap' : ''}"><div class="bubble">${showWho ? who : ''}${body}<div class="bubble-meta">${esc(fmtTime(m.timestamp))}</div></div></div>`;
    lastDir = dir;
    return html;
  }).join('');
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
    if (row) openChat(row.dataset.jid);
  });
  $('convo-back').addEventListener('click', closeConvo);
  $('convo-reload').addEventListener('click', () => loadConversation(true));
  $('composer').addEventListener('submit', sendFromComposer);
  const input = $('composer-input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });
}

/* ---------------- Voice note ---------------- */
const player = new Audio();
let playingName = null;

player.addEventListener('timeupdate', () => {
  if (!playingName || !player.duration) return;
  const row = document.querySelector(`.voice-row[data-name="${CSS.escape(playingName)}"] .voice-track i`);
  if (row) row.style.width = `${(player.currentTime / player.duration) * 100}%`;
});
player.addEventListener('ended', () => stopPlayback());
player.addEventListener('error', () => { if (playingName) toast('File audio tidak bisa diputar di browser ini', 'error'); stopPlayback(); });

function stopPlayback() {
  playingName = null;
  qsa('.play-btn.playing').forEach((b) => { b.classList.remove('playing'); b.innerHTML = icon('play'); b.setAttribute('aria-label', 'Putar'); });
  qsa('.voice-track i').forEach((i) => { i.style.width = '0'; });
}

function togglePlay(name, btn) {
  if (playingName === name) { player.pause(); stopPlayback(); return; }
  player.pause();
  stopPlayback();
  playingName = name;
  player.src = `/api/voice-files/${encodeURIComponent(name)}/audio`;
  player.play().catch(() => { /* ditangani oleh event error */ });
  btn.classList.add('playing');
  btn.innerHTML = icon('pause');
  btn.setAttribute('aria-label', 'Jeda');
}

async function loadVoiceFiles() {
  try {
    const d = await api('/voice-files');
    state.voice = d.details || (d.files || []).map((name) => ({ name, size: 0, modified: 0 }));
    renderVoiceList();
  } catch {
    $('voice-files').innerHTML = '<li class="empty"><strong>Gagal memuat voice note</strong>Coba segarkan halaman.</li>';
  }
}

function renderVoiceList() {
  const q = $('voice-search').value.trim().toLowerCase();
  const list = state.voice.filter((f) => f.name.toLowerCase().includes(q));
  $('voice-count').textContent = state.voice.length ? `(${state.voice.length})` : '';
  const ul = $('voice-files');
  if (!state.voice.length) {
    ul.innerHTML = '<li class="empty"><strong>Pustaka masih kosong</strong>Unggah file audio di atas. Bot tidak akan mengirim voice note sebelum ada file.</li>';
    return;
  }
  if (!list.length) { ul.innerHTML = '<li class="empty"><strong>Tidak ada hasil</strong>Coba kata kunci lain.</li>'; return; }
  const was = playingName;
  ul.innerHTML = list.map((f) => `
    <li class="voice-row" data-name="${esc(f.name)}">
      <button class="play-btn ${was === f.name ? 'playing' : ''}" type="button" aria-label="${was === f.name ? 'Jeda' : 'Putar'}">${icon(was === f.name ? 'pause' : 'play')}</button>
      <div class="voice-info"><div class="voice-name" title="${esc(f.name)}">${esc(f.name)}</div><div class="voice-track"><i></i></div></div>
      <div class="voice-meta"><b>${esc(fmtSize(f.size))}</b>${f.modified ? esc(new Date(f.modified).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })) : ''}</div>
      <button class="icon-btn del-btn" type="button" aria-label="Hapus ${esc(f.name)}" title="Hapus">${icon('trash')}</button>
    </li>`).join('');
}

async function uploadVoiceFiles(files) {
  const zone = $('dropzone');
  const list = [...files];
  if (!list.length) return;
  zone.classList.add('busy');
  let ok = 0;
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name}: lebih dari 25 MB`, 'error'); continue; }
    try {
      await api('/voice-files?name=' + encodeURIComponent(f.name), {
        method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f,
      });
      ok++;
    } catch (err) { toast(`${f.name}: ${err.message}`, 'error'); }
  }
  zone.classList.remove('busy');
  if (ok) toast(ok === 1 ? 'Voice note diunggah' : `${ok} voice note diunggah`);
  loadVoiceFiles();
}

async function deleteVoice(name) {
  if (!confirm(`Hapus "${name}" dari pustaka? File akan dihapus dari folder voice-notes.`)) return;
  if (playingName === name) { player.pause(); stopPlayback(); }
  try {
    await api('/voice-files/' + encodeURIComponent(name), { method: 'DELETE' });
    toast('Voice note dihapus');
    loadVoiceFiles();
  } catch (err) { toast('Gagal menghapus: ' + err.message, 'error'); }
}

function initVoice() {
  const zone = $('dropzone'); const input = $('voice-input');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { uploadVoiceFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => uploadVoiceFiles(e.dataTransfer.files));
  $('voice-search').addEventListener('input', debounce(renderVoiceList, 100));
  $('voice-files').addEventListener('click', (e) => {
    const row = e.target.closest('.voice-row');
    if (!row) return;
    const name = row.dataset.name;
    if (e.target.closest('.play-btn')) togglePlay(name, row.querySelector('.play-btn'));
    else if (e.target.closest('.del-btn')) deleteVoice(name);
    else if (e.target.closest('.voice-track') && playingName === name && player.duration) {
      const r = row.querySelector('.voice-track').getBoundingClientRect();
      player.currentTime = ((e.clientX - r.left) / r.width) * player.duration;
    }
  });
}

/* ---------------- Pengaturan ---------------- */
async function loadSettings() {
  try {
    const d = await api('/settings');
    for (const key of SETTING_FIELDS) {
      const el = $('set-' + key);
      if (!el) continue;
      if (key === 'AUTO_REPLY_ENABLED') { el.value = d[key] ? 'true' : 'false'; continue; }
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
  loadStats(); loadRecent(); loadChats(); loadVoiceFiles(); loadAiStatus();
  if (state.page === 'settings') loadLogs();
  if (state.activeJid) loadConversation();
  toast('Data diperbarui');
}

/* ---------------- Socket ---------------- */
const refreshSoon = debounce(() => {
  loadChats();
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
  socket.on('connect', () => { socketConnected = true; socket.emit('status-request'); socket.emit('qr-request'); });
  socket.on('disconnect', () => {
    socketConnected = false;
    setStatus(false, null); showQR(null);
    setLoginStatus('Terputus dari server. Mencoba menyambung kembali…', true);
  });
}

/* ---------------- Boot ---------------- */
async function boot() {
  initNavigation(); initChat(); initVoice(); initSettings();
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
