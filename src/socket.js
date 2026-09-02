import { Server } from 'socket.io';

let io;
let getStatusFn = () => ({ connected: false, user: null });
let latestQr = null;

export function initSocket(server, { getStatus = () => ({ connected: false, user: null }) } = {}) {
  getStatusFn = getStatus;
  io = new Server(server, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    sendState(socket);
    socket.on('status-request', () => sendState(socket));
    socket.on('qr-request', () => {
      socket.emit('qr', latestQr);
    });
  });

  return io;
}

function sendState(socket) {
  const target = socket || io;
  target.emit('status', getStatusFn());
}

export function setLatestQr(dataUrl) {
  latestQr = dataUrl;
  if (io && dataUrl) io.emit('qr', dataUrl);
}

export function clearLatestQr() {
  latestQr = null;
  if (io) io.emit('qr', null);
}

export function getIO() {
  return io;
}

export function emit(event, data) {
  if (io) io.emit(event, data);
}
