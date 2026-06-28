import fs from 'node:fs';
import { MANIFEST_PATH, DATA_DIR } from './config.js';

// Desired-state record used for listing/export context. NOT the merge gate —
// the inline markers in the host files decide what gets rewritten.

// Returns a NULL-prototype object: domains index it directly (m[domain]), so a prototype-less
// receiver makes those writes/deletes incapable of polluting Object.prototype (and CodeQL
// recognizes it as a safe sink). JSON.parse never sets a real prototype, so the copy is faithful.
export function loadManifest() {
  try {
    return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')));
  } catch {
    return Object.create(null);
  }
}

export function saveManifest(m) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${MANIFEST_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, MANIFEST_PATH);
}

// Reject keys that would walk/pollute Object.prototype when used as a manifest property.
// Domains are hostname-validated upstream (which already excludes these), but guarding at the
// property-access sink is the defensive belt-and-suspenders.
export function safeKey(k) {
  return typeof k === 'string' && k !== '__proto__' && k !== 'prototype' && k !== 'constructor';
}

export function forgetHost(domain) {
  if (!safeKey(domain)) return;
  const m = loadManifest();
  if (Object.prototype.hasOwnProperty.call(m, domain)) { delete m[domain]; saveManifest(m); }
}
