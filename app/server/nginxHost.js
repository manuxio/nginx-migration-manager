import fs from 'node:fs';
import path from 'node:path';
import { SITES_DIR } from './config.js';

// Inline markers identify the lines mass-import / switch are allowed to rewrite.
// Any line WITHOUT a marker is preserved verbatim. A file with NO markers is
// treated as fully hand-authored and never touched.
//
// Each host carries TWO upstreams (primary + alt) and an "active" selector.
// The proxy_pass line points at whichever is active; the GUI flips between them.
const M_SERVERNAME = '# managed:server_name';
const M_PRIMARY = '# managed:primary';
const M_ALT = '# managed:alt';
const M_ACTIVE = '# managed:active';
const M_UPSTREAM = '# managed:upstream';

const reServerName = /#\s*managed:server_name\b/;
const rePrimary = /#\s*managed:primary\b/;
const reAlt = /#\s*managed:alt\b/;
const reActive = /#\s*managed:active\b/;
const reUpstream = /#\s*managed:upstream\b/;

function confPath(domain) {
  return path.join(SITES_DIR, `${domain}.conf`);
}

// Value after "# managed:<key>" on its line, or null if the marker line is absent.
function getMarker(content, key) {
  const re = new RegExp(`#[ \\t]*managed:${key}\\b[ \\t]*(.*)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

// "addr:port" -> { address, port }
export function splitHostPort(s) {
  if (!s) return { address: '', port: '' };
  const i = s.lastIndexOf(':');
  if (i < 0) return { address: s, port: '' };
  return { address: s.slice(0, i), port: s.slice(i + 1) };
}

// Returns the on-disk file for a domain: enabled (.conf) or disabled (.conf.disabled), or null.
export function existingFileFor(domain) {
  const enabled = confPath(domain);
  const disabled = `${enabled}.disabled`;
  if (fs.existsSync(enabled)) return enabled;
  if (fs.existsSync(disabled)) return disabled;
  return null;
}

// Full file body for a brand-new host (includes all managed markers).
export function renderHost({ domain, address, port, altAddress, altPort, active }) {
  const primary = `${address}:${port}`;
  const alt = altAddress ? `${altAddress}:${altPort}` : '';
  const act = active === 'alt' && alt ? 'alt' : 'primary';
  const activeTarget = act === 'alt' ? alt : primary;
  const altLine = alt ? `${M_ALT} ${alt}` : M_ALT;

  return `# managed-by: nginx-managed
# domain: ${domain}
# Generated file. Lines tagged "# managed:*" are rewritten on mass-import;
# every other line is preserved. Delete a marker to pin that line by hand.
server {
    listen 80;
    listen 443 ssl;
    http2 on;

    server_name ${domain};  ${M_SERVERNAME}

    location / {
        ${M_PRIMARY} ${primary}
        ${altLine}
        ${M_ACTIVE} ${act}
        proxy_pass http://${activeTarget};  ${M_UPSTREAM}
        include /etc/nginx/snippets/proxy.conf;
    }
}
`;
}

// Surgically rewrite only the managed lines (primary/alt/active/upstream/server_name).
// Keeps the operator's active selection sticky; refreshes upstream values from CSV.
// Returns { manual, changed, content }.
export function mergeHost(existing, { domain, address, port, altAddress, altPort }) {
  const lines = existing.split('\n');
  const hasMarkers = lines.some((l) => reUpstream.test(l) || rePrimary.test(l) || reServerName.test(l));
  if (!hasMarkers) return { manual: true, changed: false, content: existing };

  const newPrimary = `${address}:${port}`;
  const newAlt = altAddress ? `${altAddress}:${altPort}` : '';
  let active = (getMarker(existing, 'active') || 'primary').toLowerCase();
  if (active !== 'alt') active = 'primary';
  if (active === 'alt' && !newAlt) active = 'primary'; // can't stay on a removed alt
  const activeTarget = active === 'alt' ? newAlt : newPrimary;

  let changed = false;
  let sawPrimary = false;
  let upstreamIdx = -1;
  let upstreamIndent = '        ';
  const mark = (was, next) => { if (next !== was) changed = true; return next; };

  const out = lines.map((line, i) => {
    const indent = (line.match(/^\s*/) || [''])[0];
    if (reServerName.test(line)) return mark(line, `${indent}server_name ${domain};  ${M_SERVERNAME}`);
    if (rePrimary.test(line)) { sawPrimary = true; return mark(line, `${indent}${M_PRIMARY} ${newPrimary}`); }
    if (reAlt.test(line)) return mark(line, (newAlt ? `${indent}${M_ALT} ${newAlt}` : `${indent}${M_ALT}`));
    if (reActive.test(line)) return mark(line, `${indent}${M_ACTIVE} ${active}`);
    if (reUpstream.test(line)) {
      upstreamIdx = i; upstreamIndent = indent;
      return mark(line, `${indent}proxy_pass http://${activeTarget};  ${M_UPSTREAM}`);
    }
    return line;
  });

  // Legacy/partial files: inject the primary/alt/active markers above proxy_pass if missing.
  if (!sawPrimary && upstreamIdx >= 0) {
    out.splice(upstreamIdx, 0,
      `${upstreamIndent}${M_PRIMARY} ${newPrimary}`,
      newAlt ? `${upstreamIndent}${M_ALT} ${newAlt}` : `${upstreamIndent}${M_ALT}`,
      `${upstreamIndent}${M_ACTIVE} ${active}`);
    changed = true;
  }

  return { manual: false, changed, content: out.join('\n') };
}

// Flip the active upstream. target = 'primary' | 'alt' | undefined (toggle).
// Returns { error } or { changed, content, active, upstream }.
export function switchActive(existing, target) {
  if (!reUpstream.test(existing)) return { error: 'host is hand-authored (no managed markers)' };

  const proxyMatch = existing.match(/proxy_pass\s+https?:\/\/([^;\s]+)/i);
  const primary = getMarker(existing, 'primary') || (proxyMatch ? proxyMatch[1] : '');
  const alt = getMarker(existing, 'alt') || '';
  let active = (getMarker(existing, 'active') || 'primary').toLowerCase();
  if (active !== 'alt') active = 'primary';

  const want = target ? String(target).toLowerCase() : active === 'alt' ? 'primary' : 'alt';
  if (want !== 'primary' && want !== 'alt') return { error: 'target must be primary or alt' };
  if (want === 'alt' && !alt) return { error: 'no alternate upstream configured' };
  const upstream = want === 'alt' ? alt : primary;
  if (!upstream) return { error: 'no upstream to switch to' };

  let changed = false;
  let sawActive = false;
  let upstreamIdx = -1;
  let upIndent = '        ';
  const mark = (was, next) => { if (next !== was) changed = true; return next; };

  const lines = existing.split('\n');
  const out = lines.map((line, i) => {
    const indent = (line.match(/^\s*/) || [''])[0];
    if (reActive.test(line)) { sawActive = true; return mark(line, `${indent}${M_ACTIVE} ${want}`); }
    if (reUpstream.test(line)) {
      upstreamIdx = i; upIndent = indent;
      return mark(line, `${indent}proxy_pass http://${upstream};  ${M_UPSTREAM}`);
    }
    return line;
  });
  if (!sawActive && upstreamIdx >= 0) { out.splice(upstreamIdx, 0, `${upIndent}${M_ACTIVE} ${want}`); changed = true; }

  return { changed, content: out.join('\n'), active: want, upstream };
}

// Read host state for listing/export.
export function parseHost(content) {
  const managed = /#\s*managed:(upstream|primary|server_name)\b/.test(content);
  const pm = content.match(/proxy_pass\s+https?:\/\/([^;\s]+)/i);
  const activeUpstream = pm ? pm[1] : '';
  let primary = getMarker(content, 'primary');
  if (primary === null) primary = activeUpstream;
  const alt = getMarker(content, 'alt') || '';
  let active = (getMarker(content, 'active') || 'primary').toLowerCase();
  if (active !== 'alt') active = 'primary';
  return { managed, primary: primary || '', alt, active, activeUpstream };
}

// Enable (.conf) or disable (.conf.disabled) a host by renaming. nginx's
// include *.conf stops matching a disabled file, so a reload drops that server.
// Returns { error } | { changed }.
export function setEnabled(domain, enabled) {
  const enabledPath = confPath(domain);
  const disabledPath = `${enabledPath}.disabled`;
  if (enabled) {
    if (fs.existsSync(enabledPath)) return { changed: false };
    if (!fs.existsSync(disabledPath)) return { error: 'no such host' };
    fs.renameSync(disabledPath, enabledPath);
    return { changed: true };
  }
  if (!fs.existsSync(enabledPath)) {
    return fs.existsSync(disabledPath) ? { changed: false } : { error: 'no such host' };
  }
  fs.renameSync(enabledPath, disabledPath);
  return { changed: true };
}

// Delete a single host's file. Deliberate, single-host only — the commit in git makes
// it recoverable. (Bulk import never deletes; that invariant is unchanged.)
export function deleteHost(domain) {
  const file = existingFileFor(domain);
  if (!file) return { error: 'no such host' };
  fs.unlinkSync(file);
  return { ok: true, file: path.basename(file) };
}

// Atomic write: tmp + rename so nginx never reads a half-written file.
export function writeHostFile(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// List all host files with their status.
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
    const h = parseHost(content);
    out.push({
      domain, file: name, enabled,
      managed: h.managed,
      primary: h.primary, alt: h.alt,
      active: h.active, activeUpstream: h.activeUpstream,
    });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

export { confPath };
