import fs from 'fs';

// Satu-satunya sumber versi aplikasi: field "version" di package.json.
let v = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.version) v = String(pkg.version);
} catch {}

export const APP_VERSION = v;
