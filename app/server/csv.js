// Minimal CSV reader/writer for the "domain,address,port,alt_address,alt_port" shape.
// Handles double-quoted fields and escaped quotes ("") — enough for this use case.

function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Parse CSV text -> [{ domain, address, port, altAddress, altPort }].
// Skips blanks, comments (#), and an optional header row (first row containing "domain").
// A valid row (5 short fields: host/path, two addresses, two ports) is well under this. The
// cap bounds parseLine's per-character scan so a single pathological multi-MB "line" can't
// turn into a multi-million-iteration loop.
const MAX_LINE = 4096;

export function parseCsv(text) {
  const rows = [];
  const lines = String(text).split(/\r?\n/);
  let headerChecked = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.length > MAX_LINE) continue;
    const f = parseLine(line);
    if (!headerChecked) {
      headerChecked = true;
      // Only skip a row that actually looks like the column header. A bare "contains 'domain'"
      // test would drop a real first row whose host contains "domain" (e.g. domain.example.com).
      // The documented header names its first column "domain-name" and its second "address".
      const c0 = (f[0] || '').toLowerCase();
      const c1 = (f[1] || '').toLowerCase();
      if (/^domain[-_\s]?name$/.test(c0) || c1 === 'address') continue; // skip header
    }
    rows.push({
      domain: f[0] || '',
      address: f[1] || '',
      port: f[2],
      altAddress: f[3] || '',
      altPort: f[4],
    });
  }
  return rows;
}

function quote(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

// hosts: [{ domain, address, port, altAddress, altPort }] -> CSV text with header.
export function toCsv(hosts) {
  const header = '"domain-name","address","port","alt_address","alt_port"';
  const body = hosts.map((h) =>
    [h.domain, h.address, h.port, h.altAddress, h.altPort].map(quote).join(','));
  return [header, ...body].join('\n') + '\n';
}
