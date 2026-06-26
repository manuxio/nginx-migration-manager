import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SITES_DIR } from './config.js';

function git(args, opts = {}) {
  return execFileSync('git', ['-C', SITES_DIR, ...args], { encoding: 'utf8', ...opts });
}

const IGNORE = [
  '.reload-ok', '.reload-msg', '.reload-request',
  '.test-ok', '.test-msg', '.test-request',
  '*.tmp', '',
].join('\n');

// Initialise the sites dir as a git repo (idempotent) and keep .gitignore current.
export function ensureRepo() {
  fs.mkdirSync(SITES_DIR, { recursive: true });
  const fresh = !fs.existsSync(path.join(SITES_DIR, '.git'));
  if (fresh) {
    git(['init', '-q']);
    git(['config', 'user.email', 'nginx-managed@local']);
    git(['config', 'user.name', 'nginx-managed']);
  }
  fs.writeFileSync(path.join(SITES_DIR, '.gitignore'), IGNORE);
  if (fresh) {
    git(['add', '-A']);
    try { git(['commit', '-q', '-m', 'init: nginx-managed sites repo']); } catch { /* empty */ }
  } else {
    commitAll('chore: refresh .gitignore'); // commits only if it actually changed
  }
}

// Stage everything and commit if there is a change. Returns true if a commit was made.
export function commitAll(message) {
  git(['add', '-A']);
  try {
    git(['diff', '--cached', '--quiet']);
    return false; // no staged changes
  } catch {
    git(['commit', '-q', '-m', message]);
    return true;
  }
}

// Roll the whole config back to a checkpoint commit. DESTRUCTIVE: every change made
// after <hash> is discarded (git reset --hard). The dropped commits remain recoverable
// via `git reflog` until gc. Returns { error } | { ok }.
export function rollbackTo(hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return { error: 'invalid commit hash' };
  try {
    git(['cat-file', '-e', `${hash}^{commit}`]); // ensure it's a real commit
  } catch {
    return { error: 'unknown commit' };
  }
  try {
    git(['reset', '--hard', hash]);
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e).split('\n')[0] };
  }
}

// Recent history -> [{ hash, date, message }] (date is ISO with timezone, e.g. 2026-06-25 23:02:13 +0000)
export function history(limit = 30) {
  try {
    const out = git(['log', `-n${limit}`, '--pretty=format:%h%x09%ci%x09%s']);
    if (!out.trim()) return [];
    return out
      .trim()
      .split('\n')
      .map((l) => {
        const [hash, date, ...msg] = l.split('\t');
        return { hash, date, message: msg.join('\t') };
      });
  } catch {
    return [];
  }
}
