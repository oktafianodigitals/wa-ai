import { config } from './config.js';
import { getHistory, formatHistoryForAI } from './db.js';
import { callChat } from './ai-client.js';

export { formatAIError } from './ai-client.js';

export async function chatWithAI(chatJid, userMessage, opts = {}) {
  const historyLimit = typeof opts.historyLimit === 'number' ? opts.historyLimit : config.MAX_HISTORY;
  const history = getHistory(chatJid, historyLimit);
  const messages = formatHistoryForAI(history);

  const systemContent = [config.AI_SYSTEM_PROMPT, config.EXTRA_PROMPT].filter(Boolean).join('\n\n');

  // Pesan terbaru sudah tersimpan di DB sebelum AI dipanggil; hindari duplikat di akhir riwayat.
  const last = messages[messages.length - 1];
  if (!(last && last.role === 'user' && last.content === userMessage)) {
    messages.push({ role: 'user', content: userMessage });
  }

  const { text, ms, url } = await callChat({
    model: config.AI_MODEL,
    messages: [
      { role: 'system', content: systemContent },
      ...messages,
    ],
    stream: true,
  }, { timeoutMs: 90000, retries: 3 });

  console.log(`[AI] Balasan diterima (${ms} ms) via ${url}`);
  return text;
}
