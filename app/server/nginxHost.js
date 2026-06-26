import fs from 'node:fs';
import path from 'node:path';
import { SITES_DIR } from './config.js';

// A domain = one .conf file holding one `location` block per ROUTE. Each route has its own
// primary (Backend A) + alt (Backend B) upstreams and an active selector, tagged with
// inline managed markers so mass-import / switch only rewrite those lines and hand edits
// (and hand-added location blocks) are preserved.
const M_SERVERNAME = '# managed:server_name';
const M_ROUTE = '# managed:route';
const M_PRIMARY = '# managed:primary';
const M_ALT = '# managed:alt';
const M_ACTIVE = '# managed:active';
const M_UPSTREAM = '# managed:upstream';

const reServerName = /#\s*managed:server_name\b/;
const reRoute = /#\s*managed:route\b/;
const rePrimary = /#\s*managed:primary\b/;
const reAlt = /#\s*managed:alt\b/;
const reActive = /#\s*managed:active\b/;
const reUpstream = /#\s*managed:upstream\b/;

function confPath(domain) {
  return path.join(SITES_DIR, `${domain}.conf`);
}

// Value after "# managed:<key>" on a line (or null if that marker isn't on the line).
function markerVal(line, key) {
  const m = line.match(new RegExp(`#[ \\t]*managed:${key}\\b[ \\t]*(.*)$`));
  return m ? m[1].trim() : null;
}

// "addr:port" -> { address, port }
export function splitHostPort(s) {
  if (!s) return { address: '', port: '' };
  const i = s.lastIndexOf(':');
  if (i < 0) return { address: s, port: '' };
  return { address: s.slice(0, i), port: s.slice(i + 1) };
}

// "www.example.com/api/*" -> { domain, path:'/api/*' };  "www.example.com" -> { domain, path:'' }
export function splitDomainPath(s) {
  const v = String(s || '').trim();
  const i = v.indexOf('/');
  if (i < 0) return { domain: v.toLowerCase(), path: '' };
  return { domain: v.slice(0, i).toLowerCase(), path: v.slice(i) };
}

const normPath = (p) => { const v = String(p || '').trim(); return v === '' ? '/' : v; };
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// Path pattern -> nginx location directive (hybrid):
//   '' or '/'            -> location /            (whole site, catch-all)
//   trailing '*'         -> location <prefix>     (prefix match)
//   '*' elsewhere        -> location ~ ^<regex>   (* -> .*)
//   no '*'               -> location = <path>     (exact)
export function pathToLocation(rawPath) {
  let p = String(rawPath || '').trim();
  if (p === '' || p === '/') return { key: '/', directive: 'location /' };
  if (!p.startsWith('/')) p = `/${p}`;
  const stars = (p.match(/\*/g) || []).length;
  if (stars === 0) return { key: p, directive: `location = ${p}` };
  if (stars === 1 && p.endsWith('*')) return { key: p, directive: `location ${p.slice(0, -1)}` };
  return { key: p, directive: `location ~ ${'^' + p.split('*').map(escapeRe).join('.*')}` };
}

// Canonical route identity = the nginx location directive it produces. Two paths that yield
// the same location (e.g. '/' and '/*' both -> 'location /') are the SAME route — keying on
// this prevents duplicate location blocks (which make the config invalid).
export function locKey(path) { return pathToLocation(path).directive; }

// One location block (4-space server indent).
export function renderRouteBlock(route) {
  const { directive } = pathToLocation(route.path);
  const primary = `${route.address}:${route.port}`;
  const alt = route.altAddress ? `${route.altAddress}:${route.altPort}` : '';
  const act = route.active === 'alt' && alt ? 'alt' : 'primary';
  const target = act === 'alt' ? alt : primary;
  const altLine = alt ? `${M_ALT} ${alt}` : M_ALT;
  return [
    `    ${M_ROUTE} ${normPath(route.path)}`,
    `    ${directive} {`,
    `        ${M_PRIMARY} ${primary}`,
    `        ${altLine}`,
    `        ${M_ACTIVE} ${act}`,
    `        proxy_pass http://${target};  ${M_UPSTREAM}`,
    `        include /etc/nginx/snippets/proxy.conf;`,
    `    }`,
  ].join('\n');
}

// Full file for a domain (HTTP/80 only; root route emitted last so it reads as the fallback).
export function renderDomain({ domain, routes }) {
  const byLoc = new Map();
  for (const r of routes) byLoc.set(locKey(r.path), r); // dedupe equivalent locations (last wins)
  const sorted = [...byLoc.values()].sort((a, b) => (normPath(a.path) === '/' ? 1 : normPath(b.path) === '/' ? -1 : 0));
  const blocks = sorted.map(renderRouteBlock).join('\n\n');
  return `# managed-by: nginx-managed
# domain: ${domain}
# Generated. One location per route; lines tagged "# managed:*" are rewritten on import,
# everything else (including hand-added location blocks) is preserved.
server {
    listen 80;

    server_name ${domain};  ${M_SERVERNAME}

${blocks}
}
`;
}

// Parse a domain file into its managed routes. Legacy single-location files (managed markers
// but no "# managed:route") are read as one implicit root route ('/').
export function parseDomain(content) {
  const managed = /#\s*managed:(route|upstream|primary|server_name)\b/.test(content);
  const routes = [];
  const lines = content.split('\n');
  let cur = null;
  const pushCur = () => { if (cur) routes.push(cur); };

  const hasRouteMarkers = reRoute.test(content);
  if (!hasRouteMarkers && /#\s*managed:(upstream|primary)\b/.test(content)) {
    cur = { path: '/', primary: '', alt: '', active: 'primary', activeUpstream: '' }; // legacy root
  }

  for (const line of lines) {
    if (reRoute.test(line)) { pushCur(); cur = { path: normPath(markerVal(line, 'route') || '/'), primary: '', alt: '', active: 'primary', activeUpstream: '' }; continue; }
    if (!cur) continue;
    if (rePrimary.test(line)) cur.primary = markerVal(line, 'primary') || '';
    else if (reAlt.test(line)) cur.alt = markerVal(line, 'alt') || '';
    else if (reActive.test(line)) { const a = (markerVal(line, 'active') || 'primary').toLowerCase(); cur.active = a === 'alt' ? 'alt' : 'primary'; }
    else if (reUpstream.test(line)) { const m = line.match(/proxy_pass\s+https?:\/\/([^;\s]+)/i); if (m) cur.activeUpstream = m[1]; }
  }
  pushCur();
  // legacy fallback: if primary unknown, take it from the proxy_pass
  for (const r of routes) { if (!r.primary && r.activeUpstream) r.primary = r.activeUpstream; }
  return { managed, routes };
}

function insertBeforeServerClose(content, blocks) {
  const idx = content.lastIndexOf('\n}');
  if (idx < 0) return `${content}\n${blocks}\n`;
  return `${content.slice(0, idx)}\n${blocks}${content.slice(idx)}`;
}

// Merge CSV routes for a domain into an existing file: surgically rewrite the marker lines of
// matching routes (active stays sticky), append new location blocks for routes not yet present,
// preserve everything else. Routes already in the file but absent from the CSV are kept.
export function mergeDomain(existing, { domain, routes }) {
  const lines = existing.split('\n');
  const hasMarkers = lines.some((l) => reRoute.test(l) || reUpstream.test(l) || reServerName.test(l));
  if (!hasMarkers) return { manual: true, changed: false, content: existing };

  const byKey = new Map(routes.map((r) => [locKey(r.path), r])); // keyed by location directive
  const present = new Set();
  let changed = false;
  let curKey = null;
  let curActive = 'primary';
  const mark = (was, next) => { if (next !== was) changed = true; return next; };

  const out = lines.map((line) => {
    const indent = (line.match(/^\s*/) || [''])[0];
    if (reServerName.test(line)) return mark(line, `${indent}server_name ${domain};  ${M_SERVERNAME}`);
    if (reRoute.test(line)) { curKey = locKey(markerVal(line, 'route') || '/'); present.add(curKey); curActive = 'primary'; return line; }
    // legacy single-location file: treat as root route
    if (curKey === null && (rePrimary.test(line) || reUpstream.test(line)) && byKey.has('location /')) { curKey = 'location /'; present.add('location /'); }

    if (curKey !== null && byKey.has(curKey)) {
      const r = byKey.get(curKey);
      const newPrimary = `${r.address}:${r.port}`;
      const newAlt = r.altAddress ? `${r.altAddress}:${r.altPort}` : '';
      if (rePrimary.test(line)) return mark(line, `${indent}${M_PRIMARY} ${newPrimary}`);
      if (reAlt.test(line)) return mark(line, newAlt ? `${indent}${M_ALT} ${newAlt}` : `${indent}${M_ALT}`);
      if (reActive.test(line)) { let a = (markerVal(line, 'active') || 'primary').toLowerCase(); if (a !== 'alt') a = 'primary'; if (a === 'alt' && !newAlt) a = 'primary'; curActive = a; return mark(line, `${indent}${M_ACTIVE} ${a}`); }
      if (reUpstream.test(line)) { const target = curActive === 'alt' ? (newAlt || newPrimary) : newPrimary; return mark(line, `${indent}proxy_pass http://${target};  ${M_UPSTREAM}`); }
    }
    return line;
  });

  let content = out.join('\n');
  // append routes not already present, deduped by location directive
  const seen = new Set(present);
  const newRoutes = [];
  for (const r of routes) { const k = locKey(r.path); if (seen.has(k)) continue; seen.add(k); newRoutes.push(r); }
  if (newRoutes.length) {
    content = insertBeforeServerClose(content, newRoutes.map((r) => `\n${renderRouteBlock(r)}\n`).join(''));
    changed = true;
  }
  return { manual: false, changed, content };
}

// Rewrite the server_name (and the "# domain:" header) to a new domain.
export function setServerName(content, domain) {
  return content
    .replace(/^(#\s*domain:).*$/m, `$1 ${domain}`)
    .replace(/^(\s*server_name\s+)[^;]*;(.*)$/m, `$1${domain};$2`);
}

// Rename a route's path: rewrite its "# managed:route" marker and the following "location"
// directive (re-derived from the new path); the A/B/active markers inside are kept.
export function renameRoute(content, oldPath, newPath) {
  const oldKey = normPath(oldPath);
  const newKey = normPath(newPath);
  const newDirective = pathToLocation(newKey).directive;
  let found = false;
  let pendingLocation = false;
  let changed = false;
  const out = content.split('\n').map((line) => {
    const indent = (line.match(/^\s*/) || [''])[0];
    if (reRoute.test(line) && normPath(markerVal(line, 'route') || '/') === oldKey) {
      found = true; pendingLocation = true; changed = true;
      return `${indent}${M_ROUTE} ${newKey}`;
    }
    if (pendingLocation && /^\s*location\s/.test(line)) {
      pendingLocation = false; changed = true;
      return `${indent}${newDirective} {`;
    }
    return line;
  });
  if (!found) return { error: 'no such route' };
  return { changed, content: out.join('\n') };
}

// Flip one route's active backend. target = 'primary' | 'alt' | undefined (toggle).
export function switchRoute(content, routePath, target) {
  const key = normPath(routePath);
  const route = parseDomain(content).routes.find((r) => normPath(r.path) === key);
  if (!route) return { error: 'no such route' };
  let active = route.active === 'alt' ? 'alt' : 'primary';
  const want = target ? String(target).toLowerCase() : active === 'alt' ? 'primary' : 'alt';
  if (want !== 'primary' && want !== 'alt') return { error: 'target must be primary or alt' };
  if (want === 'alt' && !route.alt) return { error: 'no alternate upstream configured' };
  const upstream = want === 'alt' ? route.alt : (route.primary || route.activeUpstream);
  if (!upstream) return { error: 'no upstream to switch to' };

  let curPath = null;
  let changed = false;
  const mark = (was, next) => { if (next !== was) changed = true; return next; };
  const isLegacy = !reRoute.test(content);
  const out = content.split('\n').map((line) => {
    const indent = (line.match(/^\s*/) || [''])[0];
    if (reRoute.test(line)) { curPath = normPath(markerVal(line, 'route') || '/'); return line; }
    const inScope = isLegacy ? key === '/' : curPath === key;
    if (inScope) {
      if (reActive.test(line)) return mark(line, `${indent}${M_ACTIVE} ${want}`);
      if (reUpstream.test(line)) return mark(line, `${indent}proxy_pass http://${upstream};  ${M_UPSTREAM}`);
    }
    return line;
  });
  return { changed, content: out.join('\n'), active: want, upstream };
}

// Enable (.conf) or disable (.conf.disabled) a host by renaming.
export function setEnabled(domain, enabled) {
  const enabledPath = confPath(domain);
  const disabledPath = `${enabledPath}.disabled`;
  if (enabled) {
    if (fs.existsSync(enabledPath)) return { changed: false };
    if (!fs.existsSync(disabledPath)) return { error: 'no such host' };
    fs.renameSync(disabledPath, enabledPath);
    return { changed: true };
  }
  if (!fs.existsSync(enabledPath)) return fs.existsSync(disabledPath) ? { changed: false } : { error: 'no such host' };
  fs.renameSync(enabledPath, disabledPath);
  return { changed: true };
}

// Delete a single host file. Recoverable via git (the caller commits).
export function deleteHost(domain) {
  const file = existingFileFor(domain);
  if (!file) return { error: 'no such host' };
  fs.unlinkSync(file);
  return { ok: true, file: path.basename(file) };
}

export function existingFileFor(domain) {
  const enabled = confPath(domain);
  const disabled = `${enabled}.disabled`;
  if (fs.existsSync(enabled)) return enabled;
  if (fs.existsSync(disabled)) return disabled;
  return null;
}

// Atomic write: tmp + rename so nginx never reads a half-written file.
export function writeHostFile(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// List all host files with their routes.
export function listHosts() {
  if (!fs.existsSync(SITES_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(SITES_DIR)) {
    if (name.startsWith('.')) continue;
    const enabled = name.endsWith('.conf');
    const disabled = name.endsWith('.conf.disabled');
    if (!enabled && !disabled) continue;
    const full = path.join(SITES_DIR, name);
    let content = '';
    try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const domain = name.replace(/\.conf(\.disabled)?$/, '');
    const parsed = parseDomain(content);
    out.push({ domain, file: name, enabled, managed: parsed.managed, routes: parsed.routes });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

export { confPath, normPath };
