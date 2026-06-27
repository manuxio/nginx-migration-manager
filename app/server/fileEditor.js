// Raw file browser/editor confined to CONFIG_ROOT (/etc/nginx). Dangerous by nature, so the
// ONE hard rule here is containment: every client path is resolved strictly inside the root,
// defeating ../ traversal and (for existing paths) symlink escapes. Enable/disable upstream.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_ROOT } from './config.js';

const MAX_EDIT_BYTES = 2 * 1024 * 1024;   // 2 MB — bigger files aren't sensible to hand-edit

// Canonicalize the root ONCE so a symlink/junction/casing on the root itself can't trip the
// per-path symlink guard below (e.g. /tmp -> /private/tmp, Windows Temp junctions, …).
let ROOT;
try { ROOT = fs.realpathSync(CONFIG_ROOT); } catch { ROOT = path.resolve(CONFIG_ROOT); }

// Resolve a client-supplied relative path to an absolute path guaranteed inside ROOT.
export function safePath(rel) {
  // Anchor at "/" then normalize: any leading ../ that would climb above root is dropped,
  // and an absolute-looking input is treated as root-relative (never the real fs root).
  const clean = path.normalize('/' + String(rel || '')).replace(/\\/g, '/');
  const resolved = path.join(ROOT, clean);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error('path escapes the config root');
  }
  // symlink guard: realpath of the nearest EXISTING ancestor must still be inside ROOT
  let probe = resolved;
  while (probe !== ROOT && !fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
    throw new Error('path escapes the config root (symlink)');
  }
  return resolved;
}

const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// List a directory's entries (dotfiles hidden: .git, watcher status flags, etc.).
export function listDir(rel) {
  const dir = safePath(rel);
  if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = 0; let isDir = e.isDirectory();
      try { const st = fs.statSync(full); size = st.size; isDir = st.isDirectory(); } catch { /* ignore */ }
      return { name: e.name, dir: isDir, size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: relOf(dir), entries };
}

// Read a file for editing. Refuses directories, oversize, and binary (null-byte) content.
export function readFile(rel) {
  const file = safePath(rel);
  const st = fs.statSync(file);
  if (st.isDirectory()) throw new Error('is a directory');
  if (st.size > MAX_EDIT_BYTES) return { path: relOf(file), tooLarge: true, size: st.size };
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return { path: relOf(file), binary: true, size: st.size };
  return { path: relOf(file), content: buf.toString('utf8'), size: st.size };
}

// Atomic write (tmp + rename) so nginx never reads a half-written file. BOM-stripped.
export function writeFile(rel, content) {
  const file = safePath(rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) throw new Error('is a directory');
  const text = String(content ?? '').replace(/^﻿/, '');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { path: relOf(file), saved: true, size: Buffer.byteLength(text) };
}
