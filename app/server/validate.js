// Hostname per RFC-1123 (labels, 1..63 chars, no leading/trailing hyphen), total <= 253.
const HOSTNAME =
  /^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Domain doubles as the on-disk filename, so this also guards against path traversal.
export function isValidDomain(d) {
  return typeof d === 'string' && d.length > 0 && !d.includes('..') && HOSTNAME.test(d);
}

export function isValidAddress(a) {
  if (typeof a !== 'string' || a.length === 0) return false;
  if (IPV4.test(a)) return a.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  return HOSTNAME.test(a);
}

// Returns a valid port number, or null if invalid. Empty/undefined -> default 80.
export function normalizePort(p) {
  if (p === undefined || p === null || String(p).trim() === '') return 80;
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

// Validate a parsed row -> { ok, value? , reason? }
// alt_address/alt_port are optional; if alt_address is given it must be valid.
export function validateRow(row) {
  const domain = String(row.domain || '').trim().toLowerCase();
  const address = String(row.address || '').trim();
  const port = normalizePort(row.port);
  const altAddress = String(row.altAddress || '').trim();
  const hasAlt = altAddress.length > 0;
  const altPort = hasAlt ? normalizePort(row.altPort) : '';

  if (!isValidDomain(domain)) return { ok: false, domain, reason: 'invalid domain name' };
  if (!isValidAddress(address)) return { ok: false, domain, reason: 'invalid address (need IPv4 or hostname)' };
  if (port === null) return { ok: false, domain, reason: 'invalid port (1-65535)' };
  if (hasAlt) {
    if (!isValidAddress(altAddress)) return { ok: false, domain, reason: 'invalid alt_address' };
    if (altPort === null) return { ok: false, domain, reason: 'invalid alt_port (1-65535)' };
  }

  return { ok: true, value: { domain, address, port, altAddress: hasAlt ? altAddress : '', altPort: hasAlt ? altPort : '' } };
}
