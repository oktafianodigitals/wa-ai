const APP_VERSION = '2.4.0';

const SETTING_FIELDS = [
  'DB_FILE', 'TG_SESSION_FILE', 'PORT',
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_BASE_URL_STT', 'AI_MODEL_STT',
  'MAX_HISTORY', 'DEBOUNCE_MS',
  'EXTRA_PROMPT', 'AI_SYSTEM_PROMPT', 'AI_VOICE_SELECT_PROMPT',
];

async function loadSettings() {
  try {
    const data = await api('/settings');
    for (const key of SETTING_FIELDS) {
      const el = document.getElementById('set-' + key);
      if (!el) continue;
      el.value = data[key] || '';
    }
    const keyEl = document.getElementById('set-AI_API_KEY');
    if (keyEl) {
      keyEl.placeholder = data.HAS_API_KEY ? `API key tersimpan (${data.AI_API_KEY_MASKED}) - biarkan kosong untuk mempertahankan` : 'Belum diatur - masukkan API key';
    }
  } catch (err) {}
}

async function saveSettings() {
  const btn = document.getElementById('settings-btn');
  const result = document.getElementById('settings-result');
  result.className = 'result';
  result.textContent = 'Menyimpan...';

  const payload = {};
  for (const key of SETTING_FIELDS) {
    const el = document.getElementById('set-' + key);
    if (el) payload[key] = el.value.trim();
  }
  if (payload.AI_API_KEY === '') delete payload.AI_API_KEY;

  try {
    const data = await api('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    result.className = 'result';
    result.textContent = 'Settings tersimpan ✓ ' + (data.updated.length ? '(' + data.updated.join(', ') + ')' : '') + (data.note ? ' — ' + data.note : '');
    loadSettings();
  } catch (err) {
    result.className = 'result error';
    result.textContent = 'Gagal menyimpan: ' + err.message;
  }
}

let latestQrDataUrl = null;
let socket = null;
let socketConnected = false;

async function api(path, options) {
  const res = await fetch('/api' + path, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const loginScreen = () => document.getElementById('login-screen');
const dashboard = () => document.getElementById('dashboard');

function switchToLogin() {
  loginScreen().style.display = 'flex';
  dashboard().style.display = 'none';
}

function switchToDashboard() {
  loginScreen().style.display = 'none';
  dashboard().style.display = 'block';
  loadChats();
  loadStats();
  loadVoiceFiles();
}

function setLoginStatus(text, isError = false) {
  const el = document.getElementById('login-status');
  el.textContent = text;
  el.className = 'login-status' + (isError ? ' error' : '');
}

function setLoginLoading(show) {
  document.getElementById('qr-loading').style.display = show ? 'block' : 'none';
  document.getElementById('qr-image').style.visibility = show ? 'hidden' : 'visible';
}

function setStatus(connected, user) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const info = document.getElementById('user-info');
  const logoutBtn = document.getElementById('logout-btn');

  if (connected) {
    dot.className = 'status-dot online';
    text.textContent = 'Terhubung';
    info.textContent = user?.name ? `${user.name} (${user.id})` : `ID: ${user?.id || '-'}`;
    logoutBtn.style.display = 'inline-block';
    switchToDashboard();
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Menunggu login';
    info.textContent = '';
    logoutBtn.style.display = 'none';
    switchToLogin();
  }
}

function showQR(dataUrl) {
  latestQrDataUrl = dataUrl;
  const img = document.getElementById('qr-image');

  if (!dataUrl) {
    img.removeAttribute('src');
    setLoginLoading(true);
    setLoginStatus(socketConnected ? 'Menunggu QR code...' : 'Menghubungkan ke server...');
    return;
  }
  img.src = dataUrl;
  setLoginLoading(false);
  setLoginStatus('');
}

async function loadStats() {
  try {
    const data = await api('/db/stats');
    document.getElementById('stat-messages').textContent = data.totalMessages;
    document.getElementById('stat-chats').textContent = data.totalChats;
  } catch (err) {}
}

async function loadChats() {
  try {
    const data = await api('/chats');
    const container = document.getElementById('chat-list');
    if (!data.chats.length) {
      container.innerHTML = '<div class="empty">Belum ada chat</div>';
      return;
    }
    container.innerHTML = data.chats.map(c => `
      <div class="chat-item" onclick="openChat('${escapeAttr(c.chat_jid)}')">
        <div>
          <div class="chat-jid">${escapeHtml(c.chat_jid)}</div>
          <div class="chat-last">${escapeHtml(c.last_message || '')}</div>
        </div>
        <div class="chat-meta">${c.total_messages} pesan<br>${timeAgo(c.last_time)}</div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('chat-list').innerHTML = '<div class="empty">Gagal memuat chat</div>';
  }
}

async function openChat(jid) {
  document.getElementById('history-card').style.display = 'block';
  document.getElementById('history-title').textContent = 'Riwayat: ' + jid;
  const container = document.getElementById('history');
  container.innerHTML = '<div class="empty">Memuat...</div>';

  try {
    const data = await api('/history/' + encodeURIComponent(jid) + '?limit=100');
    if (!data.messages.length) {
      container.innerHTML = '<div class="empty">Belum ada pesan</div>';
      return;
    }
    container.innerHTML = data.messages.map(m => `
      <div class="history-item ${m.is_from_bot ? 'bot' : 'user'}">
        <div class="sender">${m.is_from_bot ? 'Bot' : 'User'}</div>
        <div>${escapeHtml(m.content)}</div>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = '<div class="empty">Gagal memuat riwayat</div>';
  }
}

async function loadVoiceFiles() {
  try {
    const data = await api('/voice-files');
    const container = document.getElementById('voice-files');
    if (!data.files.length) {
      container.innerHTML = '<div class="empty">Tidak ada file voice note di folder voice-notes/</div>';
      return;
    }
    container.innerHTML = data.files
      .map(f => `<span class="voice-chip">${f}</span>`)
      .join('');
  } catch (err) {
    document.getElementById('voice-files').innerHTML = '<div class="empty">Gagal memuat</div>';
  }
}

async function sendMessage() {
  const jid = document.getElementById('send-jid').value.trim();
  const text = document.getElementById('send-text').value.trim();
  const result = document.getElementById('send-result');

  if (!jid || !text) {
    result.className = 'result error';
    result.textContent = 'Mohon isi JID dan pesan';
    return;
  }

  result.className = 'result';
  result.textContent = 'Mengirim...';
  try {
    await api('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, text }),
    });
    result.className = 'result';
    result.textContent = 'Pesan terkirim ✓';
    document.getElementById('send-text').value = '';
  } catch (err) {
    result.className = 'result error';
    result.textContent = 'Gagal: ' + err.message;
  }
}

async function logout() {
  const btn = document.getElementById('logout-btn');
  if (!confirm('Yakin ingin logout? Sesi login dan semua riwayat chat di database akan dihapus.')) return;

  btn.textContent = 'Logout...';
  btn.disabled = true;

  try {
    await api('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    alert('Logout berhasil. Scan QR baru untuk login.');
    showQR(null);
    setStatus(false, null);
  } catch (err) {
    alert('Gagal logout: ' + err.message);
  } finally {
    btn.textContent = 'Logout';
    btn.disabled = false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return mins + ' mnt';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' jam';
  return Math.floor(hours / 24) + ' hari';
}

function initSocket() {
  socket = io();

  socket.on('qr', (dataUrl) => showQR(dataUrl));

  socket.on('status', (data) => {
    setStatus(data.connected, data.user);
    if (data.connected) {
      loadChats();
    } else {
      socket.emit('qr-request');
    }
  });

  socket.on('connect', () => {
    socketConnected = true;
    socket.emit('status-request');
    socket.emit('qr-request');
  });

  socket.on('disconnect', () => {
    socketConnected = false;
    setStatus(false, null);
    showQR(null);
    setLoginStatus('Terputus dari server. Mencoba menyambung kembali...', true);
  });
}

document.getElementById('version').textContent = 'v' + APP_VERSION;

loadSettings();
initSocket();
document.getElementById('qr-image').removeAttribute('src');
showQR(null);

setInterval(() => {
  loadStats();
  loadChats();
}, 5000);

setInterval(() => {
  if (socketConnected && !latestQrDataUrl) {
    socket.emit('qr-request');
  }
}, 5000);