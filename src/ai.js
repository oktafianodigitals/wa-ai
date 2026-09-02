import fetch from 'node-fetch';
import { config } from './config.js';
import { getHistory, formatHistoryForAI } from './db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function chatWithAI(chatJid, userMessage) {
  const history = getHistory(chatJid, config.MAX_HISTORY);
  const messages = formatHistoryForAI(history);

  const systemContent = [config.AI_SYSTEM_PROMPT, config.EXTRA_PROMPT].filter(Boolean).join('\n\n');

  messages.push({ role: 'user', content: userMessage });

  const body = {
    model: config.AI_MODEL,
    messages: [
      { role: 'system', content: systemContent },
      ...messages,
    ],
    stream: true,
  };

  const maxRetries = 3;
  let lastErr;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(config.AI_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.AI_API_KEY ? { Authorization: `Bearer ${config.AI_API_KEY}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        lastErr = new Error(`AI API error ${res.status}: ${text}`);
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          throw lastErr;
        }
        await sleep(1000);
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
        return await parseStream(res);
      }

      const data = await res.json();
      const content = extractContent(data);
      if (content) return content;

      lastErr = new Error('AI returned empty response');
      await sleep(1000);
      continue;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  throw lastErr || new Error('AI request failed');
}

function extractContent(data) {
  if (data.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }
  if (data.choices?.[0]?.text) {
    return data.choices[0].text;
  }
  if (data.message?.content) {
    return data.message.content;
  }
  if (typeof data.response === 'string') {
    return data.response;
  }
  return '';
}

async function parseStream(res) {
  let text = '';
  const reader = res.body;
  let buffer = '';

  for await (const chunk of reader) {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      const payload = stripSSEPrefix(line);
      if (!payload) continue;

      try {
        const json = JSON.parse(payload);
        const piece = json.choices?.[0]?.delta?.content
          || json.choices?.[0]?.message?.content
          || json.choices?.[0]?.text
          || '';
        if (piece) text += piece;
      } catch (e) {
        // melewati baris yang bukan JSON
      }
    }
  }

  return text.trim();
}

function stripSSEPrefix(line) {
  if (line.startsWith('data:')) {
    const payload = line.slice(5).trim();
    return payload === '[DONE]' ? null : payload;
  }
  return line;
}