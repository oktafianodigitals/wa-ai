const APP_VERSION = '2.5.3';
import './logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';
import { config } from './config.js';
import { initDB } from './db.js';
import { startWA, getSock } from './baileys.js';
import { initRouter } from './router.js';
import { initSocket } from './socket.js';
import { clearAllDebounces } from './debounce.js';

const PORT = config.PORT;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

let server;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[SHUTDOWN] Received ${signal}, closing gracefully...`);
  try {
    clearAllDebounces();
  } catch {}
  try {
    const sock = getSock();
    if (sock) {
      try { sock.end(new Error('shutdown')); } catch {}
    }
  } catch {}
  if (server) {
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

async function main() {
  console.log(`=== WA-AI Auto Reply Bot v${APP_VERSION} ===`);

  initDB();
  console.log('[BOOT] Database initialized');

  const app = express();
  app.set('trust proxy', true);
  server = http.createServer(app);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));
  initRouter(app);

  initSocket(server, {
    getStatus: () => {
      try {
        const s = getSock();
        const connected = !!s?.user;
        return { connected, user: connected ? s.user : null };
      } catch {
        return { connected: false, user: null };
      }
    },
  });
  console.log('[SOCKET] WebSocket initialized');

  server.listen(PORT, () => {
    console.log(`[HTTP] Server running on port ${PORT}`);
    console.log(`[HTTP] WebUI: http://localhost:${PORT}`);
    console.log(`[HTTP] Health check: http://localhost:${PORT}/api/health`);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    if (err?.message?.includes('getSock is not defined')) {
      return;
    }
    console.error('[ERROR] Uncaught exception:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || reason;
    if (typeof msg === 'string' && msg.includes('getSock is not defined')) {
      return;
    }
    console.error('[ERROR] Unhandled rejection:', msg);
  });

  await startWA();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
