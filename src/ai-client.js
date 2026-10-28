import fetch from 'node-fetch';
import { config } from './config.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/* ------------------------------------------------------------------ */
/*  Error handling                                                     */
/* ------------------------------------------------------------------ */

export class AIError extends Error {
  constructor(message, { status = 0, code = '', hint = '', retryable = false, network = false } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
    this.network = network;
  }
}

/**
 * Node 20+ menghasilkan AggregateError dengan message KOSONG saat koneksi gagal
 * (itulah sebabnya log lama hanya menampilkan "failed, reason: ").
 * Fungsi ini menggali kode error aslinya (ECONNREFUSED, ETIMEDOUT, dst).
 */
export function digErrorCodes(err, out = new Set(), depth = 0) {
  if (!err || depth > 4) return out;
  if (err.code) out.add(String(err.code));
  if (err.errno && typeof err.errno === 'string') out.add(err.errno);
  if (Array.isArray(err.errors)) err.errors.forEach(e => digErrorCodes(e, out, depth + 1));
  if (err.cause) digErrorCodes(err.cause, out, depth + 1);
  return out;
}

function digErrorAddress(err, depth = 0) {
  if (!err || depth > 4) return '';
  if (err.address && err.port) return `${err.address}:${err.port}`;
  if (Array.isArray(err.errors)) {
    for (const e of err.errors) {
      const a = digErrorAddress(e, depth + 1);
      if (a) return a;
    }
  }
  return err.cause ? digErrorAddress(err.cause, depth + 1) : '';
}

export function describeNetworkError(err, url = '') {
  if (err instanceof AIError) return err;
  if (err?.timedOut || err?.name === 'AbortError') {
    return new AIError('Timeout: AI tidak merespons tepat waktu', {
      code: 'ETIMEDOUT', network: true, retryable: true,
      hint: 'Model terlalu lambat atau provider di 9router sedang bermasalah. Coba model lain yang lebih cepat.',
    });
  }
  const codes = [...digErrorCodes(err)];
  const code = codes[0] || '';
  const addr = digErrorAddress(err);
  let target = '';
  try { const u = new URL(url); target = u.host; } catch { /* ignore */ }
  const where = addr || target;

  let message;
  let hint = '';
  if (codes.includes('ECONNREFUSED')) {
    message = `Koneksi ditolak (ECONNREFUSED) ke ${where}`;
    hint = 'Server AI tidak berjalan di alamat/port tersebut. Pastikan 9router sudah dijalankan '
      + '(buka http://localhost:20128 di browser). Jika port berbeda, ubah AI Base URL di Pengaturan.';
  } else if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) {
    message = `Host tidak ditemukan (${code}): ${target}`;
    hint = 'Periksa penulisan hostname pada AI Base URL dan koneksi internet.';
  } else if (codes.includes('ETIMEDOUT') || codes.includes('EHOSTUNREACH') || codes.includes('ENETUNREACH')) {
    message = `Tidak dapat menjangkau ${where} (${code})`;
    hint = 'Host tidak terjangkau. Periksa jaringan/firewall.';
  } else if (codes.includes('ECONNRESET') || codes.includes('EPIPE') || codes.includes('UND_ERR_SOCKET')) {
    message = `Koneksi terputus oleh server (${code})`;
    hint = 'Server AI menutup koneksi. Biasanya sementara — akan dicoba ulang otomatis.';
  } else if (codes.some(c => c.startsWith('ERR_TLS') || c.includes('CERT') || c.includes('SSL'))) {
    message = `Masalah sertifikat/TLS (${code})`;
    hint = 'Untuk 9router lokal gunakan http:// (bukan https://).';
  } else {
    const raw = (err?.message || '').replace(/^request to .* failed, reason:\s*/i, '').trim();
    message = raw || (code ? `Gagal terhubung (${code})` : 'Gagal terhubung ke server AI (tanpa detail dari sistem)');
  }
  return new AIError(message, { code, hint, network: true, retryable: true });
}

function httpError(status, bodyText) {
  let detail = bodyText || '';
  try {
    const j = JSON.parse(bodyText);
    detail = j?.error?.message || j?.error || j?.message || j?.detail || bodyText;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* plain text */ }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 240);

  let hint = '';
  let retryable = false;
  if (status === 401 || status === 403) {
    hint = 'API key ditolak/belum diisi. Buat key di dashboard 9router (menu Endpoint → API Keys) '
      + 'lalu isi di Pengaturan → AI API Key.';
  } else if (status === 404) {
    hint = 'Endpoint tidak ditemukan. AI Base URL seharusnya http://localhost:20128/v1/chat/completions '
      + '(atau cukup http://localhost:20128/v1).';
  } else if (status === 400 || status === 422) {
    hint = /model/i.test(detail)
      ? 'Nama model tidak valid / belum aktif di 9router. Gunakan tombol "Ambil Daftar Model" untuk memilih yang tersedia.'
      : 'Permintaan ditolak oleh provider. Periksa nama model dan format pengaturan.';
  } else if (status === 429) {
    hint = 'Kuota/rate limit provider tercapai. 9router biasanya otomatis fallback jika combo diatur.';
    retryable = true;
  } else if (status >= 500) {
    hint = 'Provider/9router mengalami error internal. Akan dicoba ulang.';
    retryable = true;
  }
  return new AIError(`AI API error ${status}${detail ? `: ${detail}` : ''}`, { status, hint, retryable });
}

/** Satu string ringkas (pesan + saran) untuk log & UI. */
export function formatAIError(err) {
  const e = err instanceof AIError ? err : describeNetworkError(err);
  return e.hint ? `${e.message} — ${e.hint}` : e.message;
}

/* ------------------------------------------------------------------ */
/*  URL helpers                                                        */
/* ------------------------------------------------------------------ */

/** Terima: host saja, /v1, atau URL lengkap — kembalikan URL chat/completions. */
export function normalizeChatUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new AIError('AI Base URL belum diisi', { hint: 'Isi di Pengaturan, mis. http://localhost:20128/v1/chat/completions' });
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v1$/i.test(u)) return `${u}/chat/completions`;
  let pathname = '/';
  try { pathname = new URL(u).pathname; } catch {
    throw new AIError(`AI Base URL tidak valid: ${u}`);
  }
  if (pathname === '/' || pathname === '') return `${u}/v1/chat/completions`;
  return u;
}

export function apiRootFromChatUrl(chatUrl) {
  return chatUrl.replace(/\/chat\/completions$/i, '');
}

const workingHost = new Map(); // normalizedUrl -> host yang terakhir berhasil

/**
 * Di Windows `localhost` sering di-resolve ke ::1 (IPv6) lebih dulu, padahal 9router
 * hanya listen di IPv4 (atau sebaliknya). Kita coba beberapa varian host secara berurutan.
 */
function candidateUrls(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return [url]; }
  const list = [];
  const push = (host) => {
    const c = new URL(url);
    c.hostname = host;
    list.push(c.toString());
  };
  const cached = workingHost.get(url);
  if (cached) push(cached);
  if (LOCAL_HOSTS.has(parsed.hostname)) {
    ['127.0.0.1', 'localhost', '[::1]'].forEach(push);
  } else {
    list.push(url);
  }
  return [...new Set(list.map(s => s.toString()))];
}

/* ------------------------------------------------------------------ */
/*  Low-level request with host fallback                               */
/* ------------------------------------------------------------------ */

async function requestOnce(url, init, controller) {
  const urls = candidateUrls(url);
  const errors = [];
  for (const u of urls) {
    try {
      const res = await fetch(u, { ...init, signal: controller.signal });
      try { workingHost.set(url, new URL(u).hostname); } catch { /* ignore */ }
      return { res, usedUrl: u };
    } catch (err) {
      if (controller.signal.aborted) throw err;
      errors.push({ err, u });
    }
  }
  // Pilih error paling informatif: ECONNREFUSED dari host IPv4 lebih berguna daripada error IPv6.
  const best = errors.find(x => digErrorCodes(x.err).has('ECONNREFUSED')) || errors[0];
  const e = describeNetworkError(best.err, best.u);
  if (urls.length > 1) {
    e.message += ` (dicoba: ${urls.map(x => { try { return new URL(x).host; } catch { return x; } }).join(', ')})`;
  }
  throw e;
}

function buildHeaders(apiKey, extra = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'WA-AI-Bot/2.5.1',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/*  Chat completion                                                    */
/* ------------------------------------------------------------------ */

export async function callChat(body, opts = {}) {
  const {
    timeoutMs = 90000,
    retries = 3,
    baseUrl = config.AI_BASE_URL,
    apiKey = config.AI_API_KEY,
    onRetry,
  } = opts;

  const url = normalizeChatUrl(baseUrl);
  let lastErr;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const started = Date.now();

    try {
      const { res, usedUrl } = await requestOnce(url, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(body),
      }, controller);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw httpError(res.status, text);
      }

      const type = res.headers.get('content-type') || '';
      let text;
      if (type.includes('text/event-stream') || type.includes('ndjson')) {
        text = await parseStream(res);
      } else {
        const raw = await res.text();
        let data = null;
        try { data = JSON.parse(raw); } catch { /* maybe SSE without header */ }
        if (data) {
          if (data.error) throw httpError(res.status, JSON.stringify(data));
          text = extractContent(data);
        } else if (/^\s*data:/m.test(raw)) {
          text = parseStreamText(raw);
        } else {
          text = '';
        }
      }

      text = cleanReply(text);
      if (!text) {
        throw new AIError('AI mengembalikan respons kosong', {
          retryable: true,
          hint: 'Model mungkin belum aktif di 9router atau terkena filter. Coba model lain.',
        });
      }
      return { text, url: usedUrl, ms: Date.now() - started };
    } catch (err) {
      lastErr = controller.timedOut ? describeNetworkError({ timedOut: true }) : describeNetworkError(err, url);
      const retryable = lastErr.retryable !== false && !(lastErr.status >= 400 && lastErr.status < 500 && lastErr.status !== 429);
      if (!retryable || attempt === retries - 1) break;
      if (onRetry) onRetry(attempt + 1, lastErr);
      console.warn(`[AI] Percobaan ${attempt + 1}/${retries} gagal: ${lastErr.message}. Mengulang...`);
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new AIError('AI request failed');
}

export async function chatWithMessages(messages, extra = {}, opts = {}) {
  const { text } = await callChat({
    model: config.AI_MODEL,
    messages,
    stream: true,
    ...extra,
  }, opts);
  return text;
}

/* ------------------------------------------------------------------ */
/*  Ping / models / full diagnostic                                    */
/* ------------------------------------------------------------------ */

export async function pingAI({ baseUrl = config.AI_BASE_URL, apiKey = config.AI_API_KEY, timeoutMs = 6000 } = {}) {
  const started = Date.now();
  let chatUrl;
  try {
    chatUrl = normalizeChatUrl(baseUrl);
  } catch (err) {
    return { reachable: false, error: err.message, hint: err.hint, ms: 0 };
  }
  const modelsUrl = `${apiRootFromChatUrl(chatUrl)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const { res, usedUrl } = await requestOnce(modelsUrl, {
      method: 'GET',
      headers: buildHeaders(apiKey),
    }, controller);
    const ms = Date.now() - started;
    const text = await res.text().catch(() => '');
    let models = [];
    if (res.ok) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (j.data || j.models || []);
        models = arr.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean);
      } catch { /* ignore */ }
    }
    const authProblem = res.status === 401 || res.status === 403;
    return {
      reachable: true,
      ok: res.ok,
      status: res.status,
      authProblem,
      models,
      ms,
      url: usedUrl,
      hint: authProblem ? httpError(res.status, text).hint : '',
    };
  } catch (err) {
    const e = controller.timedOut ? describeNetworkError({ timedOut: true }) : describeNetworkError(err, modelsUrl);
    return { reachable: false, error: e.message, hint: e.hint, code: e.code, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Diagnostik bertahap untuk tombol "Tes Koneksi" di dashboard. */
export async function diagnoseAI(overrides = {}) {
  const baseUrl = overrides.baseUrl ?? config.AI_BASE_URL;
  const apiKey = overrides.apiKey || config.AI_API_KEY;
  const model = overrides.model || config.AI_MODEL;
  const steps = [];
  const result = { ok: false, steps, model };

  let chatUrl;
  try {
    chatUrl = normalizeChatUrl(baseUrl);
    steps.push({ name: 'Alamat endpoint', ok: true, detail: chatUrl });
  } catch (err) {
    steps.push({ name: 'Alamat endpoint', ok: false, detail: err.message, hint: err.hint });
    result.error = err.message;
    result.hint = err.hint;
    return result;
  }

  const ping = await pingAI({ baseUrl, apiKey });
  if (!ping.reachable) {
    steps.push({ name: 'Server dapat dijangkau', ok: false, detail: ping.error, hint: ping.hint });
    result.error = ping.error;
    result.hint = ping.hint;
    return result;
  }
  steps.push({ name: 'Server dapat dijangkau', ok: true, detail: `${ping.url} (HTTP ${ping.status}, ${ping.ms} ms)` });
  result.models = ping.models;

  if (ping.authProblem) {
    steps.push({ name: 'Autentikasi', ok: false, detail: `HTTP ${ping.status}`, hint: ping.hint });
    result.error = `API key ditolak (HTTP ${ping.status})`;
    result.hint = ping.hint;
    return result;
  }

  if (ping.models.length) {
    const found = ping.models.includes(model);
    steps.push({
      name: 'Model tersedia',
      ok: found,
      detail: found ? model : `"${model}" tidak ada di daftar (${ping.models.length} model tersedia)`,
      hint: found ? '' : 'Pilih model dari daftar yang tersedia.',
    });
  }

  try {
    const r = await callChat({
      model,
      messages: [{ role: 'user', content: 'Balas hanya dengan satu kata: OK' }],
      stream: false,
      max_tokens: 24,
    }, { baseUrl, apiKey, retries: 1, timeoutMs: 45000 });
    steps.push({ name: 'Tes percakapan', ok: true, detail: `"${r.text.slice(0, 80)}" (${r.ms} ms)` });
    result.ok = true;
    result.reply = r.text;
    result.ms = r.ms;
  } catch (err) {
    const e = describeNetworkError(err);
    steps.push({ name: 'Tes percakapan', ok: false, detail: e.message, hint: e.hint });
    result.error = e.message;
    result.hint = e.hint;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Parsing                                                            */
/* ------------------------------------------------------------------ */

function cleanReply(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function extractContent(data) {
  const c = data.choices?.[0];
  const content = c?.message?.content ?? c?.text ?? data.message?.content ?? data.response ?? '';
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return typeof content === 'string' ? content : '';
}

function pieceFromJson(json) {
  const c = json.choices?.[0];
  const piece = c?.delta?.content ?? c?.message?.content ?? c?.text ?? json.content ?? json.response ?? '';
  return typeof piece === 'string' ? piece : '';
}

function stripSSEPrefix(line) {
  if (line.startsWith('data:')) {
    const payload = line.slice(5).trim();
    return payload === '[DONE]' ? null : payload;
  }
  if (line.startsWith('event:') || line.startsWith(':') || line.startsWith('id:') || line.startsWith('retry:')) return null;
  return line;
}

function consumeLine(line, state) {
  const payload = stripSSEPrefix(line.replace(/\r$/, '').trim());
  if (!payload) return;
  try {
    const json = JSON.parse(payload);
    if (json.error) {
      throw httpError(0, JSON.stringify(json));
    }
    state.text += pieceFromJson(json);
  } catch (e) {
    if (e instanceof AIError) throw e;
    /* abaikan baris non-JSON */
  }
}

async function parseStream(res) {
  const state = { text: '' };
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, idx), state);
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer.trim()) consumeLine(buffer, state);
  } catch (err) {
    if (state.text.trim()) return state.text;
    throw err;
  }
  return state.text;
}

function parseStreamText(raw) {
  const state = { text: '' };
  raw.split('\n').forEach(l => consumeLine(l, state));
  return state.text;
}
