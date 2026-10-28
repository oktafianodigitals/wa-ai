const logs = [];
const MAX_LOGS = 1000;

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function formatArgs(args) {
  return args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

function addLog(type, args) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${type}] ${formatArgs(args)}`;
  logs.push(line);
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }
}

console.log = function (...args) {
  addLog('LOG', args);
  originalLog.apply(console, args);
};

console.error = function (...args) {
  addLog('ERR', args);
  originalError.apply(console, args);
};

console.warn = function (...args) {
  addLog('WARN', args);
  originalWarn.apply(console, args);
};

console.info = function (...args) {
  addLog('INFO', args);
  originalInfo.apply(console, args);
};

export function getLogs() {
  return logs.slice(-800).join('\n');
}

export function clearLogs() {
  logs.length = 0;
}
