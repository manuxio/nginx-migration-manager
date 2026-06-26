import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import express from 'express';

import {
  PORT, AUTH_USER, AUTH_PASS, SITES_DIR,
  RELOAD_OK, RELOAD_MSG, RELOAD_REQUEST, TEST_OK, TEST_MSG, TEST_REQUEST, PENDING, SERVED_FILE,
} from './config.js';
import { ensureRepo, history, commitAll, rollbackTo, headShort } from './gitStore.js';
import {
  listHosts, existingFileFor, switchActive, setEnabled, writeHostFile, splitHostPort, parseHost, deleteHost, mergeHost,
} from './nginxHost.js';
import { forgetHost } from './manifest.js';
import { isValidDomain, isValidAddress, normalizePort } from './validate.js';
import { toCsv } from './csv.js';
import { importCsv } from './importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '5mb' }));

// ------------------------------------------------------------------ basic auth
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
app.use((req, res, next) => {
  if (!AUTH_USER) return next(); // auth disabled
  const h = req.headers.authorization || '';
  const [scheme, enc] = h.split(' ');
  if (scheme === 'Basic' && enc) {
    const [u, p] = Buffer.from(enc, 'base64').toString().split(':');
    if (timingSafeEqual(u || '', AUTH_USER) && timingSafeEqual(p || '', AUTH_PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="nginx-managed"').status(401).send('Authentication required');
});

// helper: resolve & validate a domain from the request body/query
function reqDomain(req) {
  return String(req.body?.domain || req.query.domain || '').trim().toLowerCase();
}

// ------------------------------------------------------------------------- API
app.get('/api/hosts', (req, res) => {
  res.json({ hosts: listHosts() });
});

app.get('/api/status', (req, res) => {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
  const ro = read(RELOAD_OK);
  const to = read(TEST_OK);
  res.json({
    reload: { ok: ro === '1', known: ro !== '', message: read(RELOAD_MSG) || 'no reload yet' },
    test: { ok: to === '1', known: to !== '', message: read(TEST_MSG) || '' },
    pending: read(PENDING) === '1',
  });
});

// The commit nginx is currently serving = HEAD at the last successful reload.
function recordServed() {
  try { fs.mkdirSync(path.dirname(SERVED_FILE), { recursive: true }); fs.writeFileSync(SERVED_FILE, headShort()); } catch { /* ignore */ }
}
function readServed() {
  try { return fs.readFileSync(SERVED_FILE, 'utf8').trim(); } catch { return ''; }
}

app.get('/api/history', (req, res) => {
  res.json({ history: history(50), served: readServed(), head: headShort() });
});

// Roll the whole config back to a checkpoint commit (DESTRUCTIVE: discards later changes).
app.post('/api/rollback', (req, res) => {
  const hash = String(req.body?.hash || '').trim();
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return res.status(400).json({ error: 'invalid commit hash' });
  const r = rollbackTo(hash);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, rolledBackTo: hash });
});

app.get('/api/export', (req, res) => {
  const hosts = listHosts().map((h) => {
    const p = splitHostPort(h.primary);
    const a = splitHostPort(h.alt);
    return { domain: h.domain, address: p.address, port: p.port || 80, altAddress: a.address, altPort: a.port };
  });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="hosts.csv"');
  res.send(toCsv(hosts));
});

app.post('/api/import', (req, res) => {
  const csv = typeof req.body === 'string' ? req.body : (req.body && req.body.csv) || '';
  if (!csv.trim()) return res.status(400).json({ error: 'empty CSV' });
  const apply = String(req.query.apply) === 'true';
  try {
    res.json(importCsv(csv, apply));
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Forward to primary / alt. target = 'primary' | 'alt' | undefined (toggle).
app.post('/api/switch', (req, res) => {
  const domain = reqDomain(req);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });

  const r = switchActive(fs.readFileSync(file, 'utf8'), req.body?.target);
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.changed) {
    writeHostFile(file, r.content);
    commitAll(`switch ${domain} -> ${r.active} (${r.upstream})`);
  }
  res.json({ domain, active: r.active, upstream: r.upstream, changed: r.changed });
});

// Inline-edit one upstream (Backend A = primary, B = alt). value = "addr[:port]" ('' clears alt).
// Reuses the marker merge: keeps the active selection sticky; proxy_pass follows the active one.
app.post('/api/host/upstream', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const which = req.body?.which;
  const value = String(req.body?.value ?? '').trim();
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  if (which !== 'primary' && which !== 'alt') return res.status(400).json({ error: 'which must be primary or alt' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });

  const existing = fs.readFileSync(file, 'utf8');
  const cur = parseHost(existing);
  const p = splitHostPort(cur.primary);
  const a = splitHostPort(cur.alt);
  const row = {
    domain,
    address: p.address, port: p.port || 80,
    altAddress: a.address, altPort: a.address ? (a.port || 80) : '',
  };

  if (which === 'alt' && value === '') { // clear backend B
    row.altAddress = ''; row.altPort = '';
  } else {
    const v = splitHostPort(value);
    const port = normalizePort(v.port);
    if (!isValidAddress(v.address)) return res.status(400).json({ error: `invalid ${which} address` });
    if (port === null) return res.status(400).json({ error: `invalid ${which} port` });
    if (which === 'primary') { row.address = v.address; row.port = port; }
    else { row.altAddress = v.address; row.altPort = port; }
  }

  const merged = mergeHost(existing, row);
  if (merged.manual) return res.status(400).json({ error: 'host is hand-authored (no managed markers)' });
  const newVal = which === 'primary' ? `${row.address}:${row.port}` : (row.altAddress ? `${row.altAddress}:${row.altPort}` : '(none)');
  if (merged.changed) {
    writeHostFile(file, merged.content);
    commitAll(`edit ${which} ${domain} -> ${newVal}`);
  }
  res.json({ domain, which, changed: merged.changed, value: newVal });
});

// Peek: raw config file + parsed metadata for one host (for the in-GUI viewer).
app.get('/api/host', (req, res) => {
  const domain = reqDomain(req);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });
  const content = fs.readFileSync(file, 'utf8');
  res.json({ domain, file: path.basename(file), enabled: file.endsWith('.conf'), content, ...parseHost(content) });
});

// Bulk cutover: switch many hosts at once (the filtered set). target = 'primary' | 'alt'.
// Hosts without an alt (or otherwise unswitchable) are reported, not fatal.
app.post('/api/switch-bulk', (req, res) => {
  const target = req.body?.target;
  const domains = Array.isArray(req.body?.domains) ? req.body.domains : [];
  if (target !== 'primary' && target !== 'alt') return res.status(400).json({ error: 'target must be primary or alt' });

  const results = [];
  let changed = 0;
  for (const raw of domains) {
    const domain = String(raw || '').trim().toLowerCase();
    if (!isValidDomain(domain)) { results.push({ domain, error: 'invalid domain' }); continue; }
    const file = existingFileFor(domain);
    if (!file) { results.push({ domain, error: 'no such host' }); continue; }
    const r = switchActive(fs.readFileSync(file, 'utf8'), target);
    if (r.error) { results.push({ domain, error: r.error }); continue; }
    if (r.changed) { writeHostFile(file, r.content); changed++; }
    results.push({ domain, active: r.active, upstream: r.upstream, changed: r.changed });
  }
  if (changed > 0) commitAll(`bulk cutover: ${changed} host(s) -> ${target}`);
  res.json({ target, changed, total: domains.length, results });
});

// Enable / disable a host (rename .conf <-> .conf.disabled).
function setHostEnabled(req, res, enabled) {
  const domain = reqDomain(req);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const r = setEnabled(domain, enabled);
  if (r.error) return res.status(404).json({ error: r.error });
  if (r.changed) commitAll(`${enabled ? 'enable' : 'disable'} ${domain}`);
  res.json({ domain, enabled, changed: r.changed });
}
app.post('/api/enable', (req, res) => setHostEnabled(req, res, true));
app.post('/api/disable', (req, res) => setHostEnabled(req, res, false));

// Delete a SINGLE host (deliberate). Committed to git -> recoverable via Rollback.
app.post('/api/host/delete', (req, res) => {
  const domain = reqDomain(req);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const r = deleteHost(domain);
  if (r.error) return res.status(404).json({ error: r.error });
  forgetHost(domain);
  commitAll(`delete ${domain}`);
  res.json({ ok: true, deleted: domain });
});

// Download one host's actual nginx config file.
app.get('/api/download', (req, res) => {
  const domain = reqDomain(req);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  res.send(fs.readFileSync(file, 'utf8'));
});

// Download every host config file as a .tar.gz of the live nginx config.
app.get('/api/download-all', (req, res) => {
  const files = listHosts().map((h) => h.file);
  if (files.length === 0) return res.status(404).json({ error: 'no host files to download' });
  try {
    const tgz = execFileSync('tar', ['-czf', '-', '-C', SITES_DIR, ...files], { maxBuffer: 64 * 1024 * 1024 });
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', 'attachment; filename="nginx-sites.tar.gz"');
    res.send(tgz);
  } catch (e) {
    res.status(500).json({ error: `tar failed: ${String((e && e.message) || e)}` });
  }
});

// Explicit reload: apply the pending config. Returns the reload result.
app.post('/api/reload', async (req, res) => {
  const before = _mtime(RELOAD_OK);
  const fire = () => fs.writeFileSync(RELOAD_REQUEST, String(Date.now()));
  try { fire(); } catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
  // The one-shot watcher can miss a request that lands while it's mid-debounce on another
  // change; if the first attempt times out, fire once more (the watcher is idle by then).
  let r = await pollResult(RELOAD_OK, RELOAD_MSG, before, 3000, 'config valid — reloaded', 'reload failed — last-good kept');
  if (r.ok === null) { try { fire(); } catch { /* ignore */ } r = await pollResult(RELOAD_OK, RELOAD_MSG, before, 6000, 'config valid — reloaded', 'reload failed — last-good kept'); }
  if (r.ok === true) recordServed(); // nginx now serves the current HEAD
  res.json(r);
});

// Poll a watcher result file (.test-ok / .reload-ok) for a value fresher than `before`.
const _mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const _readTrim = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
function pollResult(okFile, msgFile, before, timeoutMs, validMsg, failMsg) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (_mtime(okFile) > before) {
        const ok = _readTrim(okFile) === '1';
        return resolve({ ok, message: _readTrim(msgFile) || (ok ? validMsg : failMsg) });
      }
      if (Date.now() - start > timeoutMs) return resolve({ ok: null, message: 'timed out waiting for nginx (is the watcher running?)' });
      setTimeout(poll, 150);
    };
    setTimeout(poll, 150);
  });
}

// On-demand `nginx -t` (no reload) via the watcher's test-request channel.
app.post('/api/config-test', async (req, res) => {
  const before = _mtime(TEST_OK);
  try { fs.writeFileSync(TEST_REQUEST, String(Date.now())); }
  catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
  res.json(await pollResult(TEST_OK, TEST_MSG, before, 5000, 'config valid', 'config test failed'));
});

// Hand-edit a host's config from the GUI: write it, commit a checkpoint, and report the
// CONFIG-TEST result. The edit is NOT applied until the user reloads (it becomes pending).
app.post('/api/host/save', async (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const content = req.body?.content;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'empty content' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });
  const before = _mtime(TEST_OK);
  try {
    writeHostFile(file, content.replace(/^﻿/, '')); // strip BOM (Windows editors)
    commitAll(`hand edit ${domain}`);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
  const t = await pollResult(TEST_OK, TEST_MSG, before, 8000, 'config valid', 'config test failed');
  res.json({ saved: true, pending: true, ok: t.ok, message: t.message });
});

// ------------------------------------------------------------- static UI + boot
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

ensureRepo();
// First boot: nginx loaded the current on-disk config (= HEAD). On later restarts keep the
// previously recorded served commit (persisted in app_data) — nginx may be on an older one.
if (!readServed()) recordServed();
app.listen(PORT, () => console.log(`[app] listening on :${PORT}`));
