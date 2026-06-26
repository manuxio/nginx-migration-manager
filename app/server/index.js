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
  listHosts, existingFileFor, switchRoute, setEnabled, writeHostFile, splitHostPort, parseDomain, deleteHost,
  mergeDomain, normPath, setServerName, renameRoute, confPath, renderDomain, locKey, deleteRoute,
} from './nginxHost.js';
import { forgetHost } from './manifest.js';
import { isValidDomain, isValidPath, isValidAddress, normalizePort } from './validate.js';
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
  const rows = [];
  for (const h of listHosts()) {
    for (const r of h.routes) {
      const p = splitHostPort(r.primary);
      const a = splitHostPort(r.alt);
      rows.push({ domain: r.path === '/' ? h.domain : h.domain + r.path, address: p.address, port: p.port || 80, altAddress: a.address, altPort: a.port });
    }
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="hosts.csv"');
  res.send(toCsv(rows));
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

// Forward ONE route to primary / alt. body: {domain, path, target?}. target omitted = toggle.
app.post('/api/switch', (req, res) => {
  const domain = reqDomain(req);
  const route = normPath(req.body?.path ?? req.query.path);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });

  const r = switchRoute(fs.readFileSync(file, 'utf8'), route, req.body?.target);
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.changed) {
    writeHostFile(file, r.content);
    commitAll(`switch ${domain}${route === '/' ? '' : route} -> ${r.active} (${r.upstream})`);
  }
  res.json({ domain, path: route, active: r.active, upstream: r.upstream, changed: r.changed });
});

// Inline-edit one ROUTE's upstream. body: {domain, path, which:'primary'|'alt', value:'addr[:port]'}.
// '' clears alt. Reuses the marker merge so the active selection stays sticky.
app.post('/api/host/upstream', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const route = normPath(req.body?.path);
  const which = req.body?.which;
  const value = String(req.body?.value ?? '').trim();
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  if (which !== 'primary' && which !== 'alt') return res.status(400).json({ error: 'which must be primary or alt' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });

  const existing = fs.readFileSync(file, 'utf8');
  const cur = parseDomain(existing).routes.find((r) => normPath(r.path) === route);
  if (!cur) return res.status(404).json({ error: 'no such route' });
  const p = splitHostPort(cur.primary);
  const a = splitHostPort(cur.alt);
  const row = { domain, path: route, address: p.address, port: p.port || 80, altAddress: a.address, altPort: a.address ? (a.port || 80) : '' };

  if (which === 'alt' && value === '') { row.altAddress = ''; row.altPort = ''; }
  else {
    const v = splitHostPort(value);
    const port = normalizePort(v.port);
    if (!isValidAddress(v.address)) return res.status(400).json({ error: `invalid ${which} address` });
    if (port === null) return res.status(400).json({ error: `invalid ${which} port` });
    if (which === 'primary') { row.address = v.address; row.port = port; }
    else { row.altAddress = v.address; row.altPort = port; }
  }

  const merged = mergeDomain(existing, { domain, routes: [row] });
  if (merged.manual) return res.status(400).json({ error: 'host is hand-authored (no managed markers)' });
  const newVal = which === 'primary' ? `${row.address}:${row.port}` : (row.altAddress ? `${row.altAddress}:${row.altPort}` : '(none)');
  if (merged.changed) {
    writeHostFile(file, merged.content);
    commitAll(`edit ${which} ${domain}${route === '/' ? '' : route} -> ${newVal}`);
  }
  res.json({ domain, path: route, which, changed: merged.changed, value: newVal });
});

// Add a new host with a default root route -> 127.0.0.1:80, no Backend B.
app.post('/api/host/add', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  if (existingFileFor(domain)) return res.status(400).json({ error: `host ${domain} already exists` });
  const route = { path: '/', address: '127.0.0.1', port: 80, altAddress: '', altPort: '' };
  writeHostFile(confPath(domain), renderDomain({ domain, routes: [route] }));
  commitAll(`add host ${domain}`);
  res.json({ domain, changed: true });
});

// Add a new route (path) to an existing host -> 127.0.0.1:80, no Backend B.
app.post('/api/host/route/add', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  let path = String(req.body?.path ?? '').trim();
  if (path !== '' && path !== '/' && !path.startsWith('/')) path = `/${path}`;
  path = normPath(path);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  if (!isValidPath(path === '/' ? '' : path)) return res.status(400).json({ error: 'invalid path (use /path or /path/*)' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });

  const existing = fs.readFileSync(file, 'utf8');
  if (parseDomain(existing).routes.some((r) => locKey(r.path) === locKey(path))) return res.status(400).json({ error: `route ${path} already exists (same location as another route)` });
  const merged = mergeDomain(existing, { domain, routes: [{ path, address: '127.0.0.1', port: 80, altAddress: '', altPort: '' }] });
  if (merged.manual) return res.status(400).json({ error: 'host is hand-authored (no managed markers)' });
  if (merged.changed) { writeHostFile(file, merged.content); commitAll(`add route ${domain} ${path}`); }
  res.json({ domain, path, changed: merged.changed });
});

// Rename a host: rename the file (.conf/.conf.disabled) and rewrite its server_name.
app.post('/api/host/rename', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const newDomain = String(req.body?.newDomain || '').trim().toLowerCase();
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  if (!isValidDomain(newDomain)) return res.status(400).json({ error: 'invalid new domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });
  if (newDomain === domain) return res.json({ domain, changed: false });
  if (existingFileFor(newDomain)) return res.status(400).json({ error: `host ${newDomain} already exists` });

  const disabled = file.endsWith('.disabled');
  const newFile = disabled ? `${confPath(newDomain)}.disabled` : confPath(newDomain);
  writeHostFile(newFile, setServerName(fs.readFileSync(file, 'utf8'), newDomain));
  fs.unlinkSync(file);
  forgetHost(domain);
  commitAll(`rename ${domain} -> ${newDomain}`);
  res.json({ domain: newDomain, changed: true });
});

// Delete a single route (path) from a host file. body: {domain, path}.
app.post('/api/host/route/delete', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const route = normPath(req.body?.path);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });
  const existing = fs.readFileSync(file, 'utf8');
  const routes = parseDomain(existing).routes;
  if (!routes.some((r) => normPath(r.path) === route)) return res.status(404).json({ error: 'no such route' });
  if (routes.length <= 1) return res.status(400).json({ error: 'cannot delete the only route — delete the host instead' });
  const r = deleteRoute(existing, route);
  if (r.error) return res.status(400).json({ error: r.error });
  writeHostFile(file, r.content);
  commitAll(`delete route ${domain} ${route}`);
  res.json({ domain, path: route, deleted: true });
});

// Rename a route's path within a host file. body: {domain, path, newPath}.
app.post('/api/host/route', (req, res) => {
  const domain = String(req.body?.domain || '').trim().toLowerCase();
  const oldPath = normPath(req.body?.path);
  let newPath = String(req.body?.newPath ?? '').trim();
  if (newPath !== '' && newPath !== '/' && !newPath.startsWith('/')) newPath = `/${newPath}`;
  newPath = normPath(newPath);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  if (!isValidPath(newPath === '/' ? '' : newPath)) return res.status(400).json({ error: 'invalid path (use /path or /path/*)' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });

  const existing = fs.readFileSync(file, 'utf8');
  const routes = parseDomain(existing).routes;
  if (!routes.some((r) => normPath(r.path) === oldPath)) return res.status(404).json({ error: 'no such route' });
  if (locKey(newPath) !== locKey(oldPath) && routes.some((r) => locKey(r.path) === locKey(newPath))) return res.status(400).json({ error: `route ${newPath} already exists (same location as another route)` });

  const r = renameRoute(existing, oldPath, newPath);
  if (r.error) return res.status(400).json({ error: r.error });
  if (r.changed) { writeHostFile(file, r.content); commitAll(`rename route ${domain} ${oldPath} -> ${newPath}`); }
  res.json({ domain, path: newPath, changed: r.changed });
});

// Peek: raw config file + parsed metadata for one host (for the in-GUI viewer).
app.get('/api/host', (req, res) => {
  const domain = reqDomain(req);
  if (!isValidDomain(domain)) return res.status(400).json({ error: 'invalid domain' });
  const file = existingFileFor(domain);
  if (!file) return res.status(404).json({ error: 'no such host' });
  const content = fs.readFileSync(file, 'utf8');
  const parsed = parseDomain(content);
  res.json({ domain, file: path.basename(file), enabled: file.endsWith('.conf'), content, managed: parsed.managed, routes: parsed.routes });
});

// Bulk cutover: switch many ROUTES at once (the filtered set). target = 'primary' | 'alt'.
// body: {items:[{domain, path}], target}. Routes are grouped per file so each file is written once.
app.post('/api/switch-bulk', (req, res) => {
  const target = req.body?.target;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (target !== 'primary' && target !== 'alt') return res.status(400).json({ error: 'target must be primary or alt' });

  const byDomain = new Map();
  for (const it of items) {
    const domain = String(it?.domain || '').trim().toLowerCase();
    if (!isValidDomain(domain)) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(normPath(it?.path));
  }

  const results = [];
  let changed = 0;
  for (const [domain, paths] of byDomain) {
    const file = existingFileFor(domain);
    if (!file) { for (const p of paths) results.push({ domain, path: p, error: 'no such host' }); continue; }
    let content = fs.readFileSync(file, 'utf8');
    let fileChanged = false;
    for (const p of paths) {
      const r = switchRoute(content, p, target);
      if (r.error) { results.push({ domain, path: p, error: r.error }); continue; }
      content = r.content;
      if (r.changed) { fileChanged = true; changed++; }
      results.push({ domain, path: p, active: r.active, upstream: r.upstream, changed: r.changed });
    }
    if (fileChanged) writeHostFile(file, content);
  }
  if (changed > 0) commitAll(`bulk cutover: ${changed} route(s) -> ${target}`);
  res.json({ target, changed, total: items.length, results });
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
