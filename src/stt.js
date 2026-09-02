import fetch from 'node-fetch';
import FormData from 'form-data';
import { config } from './config.js';

export async function transcribeAudio(audioBuffer, filename = 'audio.ogg') {
  if (!config.AI_BASE_URL_STT) {
    throw new Error('AI_BASE_URL_STT not configured');
  }

  const form = new FormData();
  form.append('file', audioBuffer, {
    filename,
    contentType: 'audio/ogg',
  });
  form.append('model', config.AI_MODEL_STT);

  const res = await fetch(config.AI_BASE_URL_STT, {
    method: 'POST',
    headers: {
      ...(config.AI_API_KEY ? { Authorization: `Bearer ${config.AI_API_KEY}` } : {}),
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`STT API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.text || '';
}