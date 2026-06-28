import fs from 'node:fs';
import { MANIFEST_PATH, DATA_DIR } from './config.js';

// Desired-state record (domain -> {...}) used for listing/export context. NOT the merge gate —
// the inline markers in the host files decide what gets rewritten. Held in memory as a Map so
// domain-keyed reads/writes/deletes never touch object prototypes (no prototype-pollution
// surface at all, regardless of the key); persisted to disk as a plain JSON object.

export function loadManifest() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))));
  } catch {
    return new Map();
  }
}

export function saveManifest(m) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m), null, 2));
  fs.renameSync(tmp, MANIFEST_PATH);
}

export function forgetHost(domain) {
  const m = loadManifest();
  if (m.delete(domain)) saveManifest(m);
}
