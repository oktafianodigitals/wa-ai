const APP_VERSION = '2.4.0';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import http from 'http';
import { config } from './config.js';
import { initDB } from './db.js';
import { startWA, getSock } from './baileys.js';
import { initRouter } from './router.js';
import { initSocket } from './socket.js';

const PORT = config.PORT;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

async function main() {
  console.log(`=== WA-AI Auto Reply Bot v${APP_VERSION} ===`);

  initDB();
  console.log('[BOOT] Database initialized');

  const app = express();
  const server = http.createServer(app);

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));
  initRouter(app);

  initSocket(server, {
    getStatus: () => {
      const s = getSock();
      const connected = !!s?.user;
      return { connected, user: connected ? s.user : null };
    },
  });
  console.log('[SOCKET] WebSocket initialized');

  server.listen(PORT, () => {
    console.log(`[HTTP] Server running on port ${PORT}`);
    console.log(`[HTTP] WebUI: http://localhost:${PORT}`);
    console.log(`[HTTP] Health check: http://localhost:${PORT}/api/health`);
  });

  await startWA();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
