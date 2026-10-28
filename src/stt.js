import fetch from 'node-fetch';
import FormData from 'form-data';
import { config } from './config.js';
import { describeNetworkError } from './ai-client.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeAudio(audioBuffer, filename = 'audio.ogg', opts = {}) {
  if (!config.AI_BASE_URL_STT) {
    throw new Error('AI_BASE_URL_STT not configured');
  }

  const maxRetries = opts.retries ?? 2;
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append('file', audioBuffer, {
        filename,
        contentType: opts.contentType || 'audio/ogg',
      });
      form.append('model', config.AI_MODEL_STT);
      if (opts.language) form.append('language', opts.language);
      if (opts.response_format) form.append('response_format', opts.response_format);

      const res = await fetchWithTimeout(config.AI_BASE_URL_STT, {
        method: 'POST',
        headers: {
          ...(config.AI_API_KEY ? { Authorization: `Bearer ${config.AI_API_KEY}` } : {}),
          ...form.getHeaders(),
          'User-Agent': 'WA-AI-Bot/2.5.0',
        },
        body: form,
      }, 120000);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`STT API error ${res.status}: ${text.slice(0, 200)}`);
        if (res.status === 401 || res.status === 403) throw lastErr;
        if (attempt < maxRetries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw lastErr;
      }

      const data = await res.json().catch(() => null);
      if (!data) throw new Error('STT returned invalid JSON');
      return data.text || data.transcript || '';
    } catch (err) {
      lastErr = describeNetworkError(err, config.AI_BASE_URL_STT);
      if (attempt < maxRetries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastErr || new Error('STT request failed');
}