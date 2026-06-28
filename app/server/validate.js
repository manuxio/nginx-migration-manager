import { splitDomainPath } from './nginxHost.js';

// Hostname per RFC-1123 (labels, 1..63 chars, no leading/trailing hyphen), total <= 253.
const HOSTNAME =
  /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Location path: starts with '/', conservative charset incl. '*' wildcard. No spaces/';'/'{'/'}'
// so it can't inject nginx directives. (Empty = bare domain = whole site.)
const PATH = /^\/[A-Za-z0-9._~%\-/*]*$/;

// Domain doubles as the on-disk filename, so this also guards against path traversal.
export function isValidDomain(d) {
  return typeof d === 'string' && d.length > 0 && !d.includes('..') && HOSTNAME.test(d);
}

export function isValidPath(p) {
  if (p === '' || p === '/') return true;
  return PATH.test(p);
}

export function isValidAddress(a) {
  if (typeof a !== 'string' || a.length === 0) return false;
  if (IPV4.test(a)) return a.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  return HOSTNAME.test(a);
}

// Returns a valid port number, or null if invalid. Empty/undefined -> default 80.
export function normalizePort(p) {
  if (p === undefined || p === null || String(p).trim() === '') return 80;
  const s = String(p).trim();
  // Digits only: reject Number()'s lenient forms ("0x50" -> 80, "1e3" -> 1000, " 8 0 ").
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  if (n < 1 || n > 65535) return null;
  return n;
}

// Validate a parsed CSV row (its "domain-name" may carry a path) -> { ok, name, value?, reason? }.
// value = { domain, path, address, port, altAddress, altPort } — one route.
export function validateRow(row) {
  const name = String(row.domain || '').trim();
  const { domain, path } = splitDomainPath(name);
  const address = String(row.address || '').trim();
  const port = normalizePort(row.port);
  const altAddress = String(row.altAddress || '').trim();
  const hasAlt = altAddress.length > 0;
  const altPort = hasAlt ? normalizePort(row.altPort) : '';

  if (!isValidDomain(domain)) return { ok: false, name, reason: 'invalid domain name' };
  if (!isValidPath(path)) return { ok: false, name, reason: 'invalid path (use /path or /path/*)' };
  if (!isValidAddress(address)) return { ok: false, name, reason: 'invalid address (need IPv4 or hostname)' };
  if (port === null) return { ok: false, name, reason: 'invalid port (1-65535)' };
  if (hasAlt) {
    if (!isValidAddress(altAddress)) return { ok: false, name, reason: 'invalid alt_address' };
    if (altPort === null) return { ok: false, name, reason: 'invalid alt_port (1-65535)' };
  }

  return { ok: true, name, value: { domain, path, address, port, altAddress: hasAlt ? altAddress : '', altPort: hasAlt ? altPort : '' } };
}
