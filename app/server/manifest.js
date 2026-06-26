import fs from 'node:fs';
import { MANIFEST_PATH, DATA_DIR } from './config.js';

// Desired-state record used for listing/export context. NOT the merge gate —
// the inline markers in the host files decide what gets rewritten.

export function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveManifest(m) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST_PATH);
}

export function recordHost(m, { domain, address, port, altAddress, altPort }, source) {
  m[domain] = { address, port, altAddress: altAddress || '', altPort: altPort || '', source, updatedAt: new Date().toISOString() };
  return m;
}

export function forgetHost(domain) {
  const m = loadManifest();
  if (m[domain]) { delete m[domain]; saveManifest(m); }
}
