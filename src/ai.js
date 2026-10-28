import { config } from './config.js';
import { getHistory, formatHistoryForAI } from './db.js';
import { callChat } from './ai-client.js';
import { imageDataUrl } from './media.js';

export { formatAIError } from './ai-client.js';

// Selalu ditambahkan di belakang system prompt agar bot tidak "bengong" saat menerima lampiran.
const FILE_HANDLING_PROMPT = `CATATAN SISTEM — LAMPIRAN:
Pelanggan bisa mengirim lampiran apa saja: gambar, dokumen, video, audio, stiker, kontak, lokasi, polling. Di riwayat, lampiran tampil sebagai teks bertanda kurung siku, mis. [Dokumen: invoice.pdf], [Gambar], [Video], [Lokasi], [Kontak], dan kadang diikuti blok [Isi file "..."] berisi teks file tersebut.
Aturan:
1. Selalu tanggapi lampiran. Akui bahwa lampiran sudah diterima dan sebutkan jenis/nama filenya.
2. Jika isi file tersedia ([Isi file ...], caption, transkrip, atau gambar terlampir), tanggapi sesuai isinya.
3. Jika isi tidak tersedia (mis. PDF, video, file biner), JANGAN berpura-pura sudah membacanya. Katakan file sudah diterima dan akan diperiksa/diteruskan, lalu tanyakan apa yang ingin pelanggan ketahui atau butuhkan.
4. Jangan pernah mengatakan bahwa kamu tidak bisa menerima file.
5. Jika ada "(file tidak dapat diunduh ...)", minta pelanggan mengirim ulang atau menjelaskan isinya dengan teks.`;

/** Gambar dari pesan pelanggan terbaru (sejak balasan bot terakhir) untuk dikirim ke AI vision. */
function collectRecentImages(history, max = 3) {
  const urls = [];
  for (let i = history.length - 1; i >= 0 && urls.length < max; i--) {
    const h = history[i];
    if (h.is_from_bot) break;
    if (h.media_type === 'image' && h.media_path) {
      const url = imageDataUrl(h.media_path, h.media_mime);
      if (url) urls.unshift(url);
    }
  }
  return urls;
}

export async function chatWithAI(chatJid, userMessage, opts = {}) {
  const historyLimit = typeof opts.historyLimit === 'number' ? opts.historyLimit : config.MAX_HISTORY;
  const history = getHistory(chatJid, historyLimit);
  const messages = formatHistoryForAI(history);

  const systemContent = [config.AI_SYSTEM_PROMPT, config.EXTRA_PROMPT, FILE_HANDLING_PROMPT].filter(Boolean).join('\n\n');

  // Pesan terbaru sudah tersimpan di DB sebelum AI dipanggil; jangan ditambahkan dua kali.
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    messages.push({ role: 'user', content: userMessage });
  }

  const request = (msgs) => callChat({
    model: config.AI_MODEL,
    messages: [{ role: 'system', content: systemContent }, ...msgs],
    stream: true,
  }, { timeoutMs: 90000, retries: 3 });

  let result;
  const images = config.AI_VISION_ENABLED ? collectRecentImages(history) : [];
  if (images.length) {
    const withImages = messages.map((m, i) => (i === messages.length - 1 && m.role === 'user'
      ? { role: 'user', content: [{ type: 'text', text: m.content }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] }
      : m));
    try {
      result = await request(withImages);
    } catch (err) {
      // Model tidak mendukung gambar → ulangi tanpa gambar supaya pelanggan tetap dibalas.
      if (err?.status >= 400 && err?.status < 500 && err.status !== 429) {
        console.warn(`[AI] Model menolak gambar (${err.message}). Mengulang tanpa gambar.`);
        result = await request(messages);
      } else throw err;
    }
  } else {
    result = await request(messages);
  }

  console.log(`[AI] Balasan diterima (${result.ms} ms) via ${result.url}`);
  return result.text;
}
