// Every API call goes through http(): a non-JSON response (a gateway/proxy error page, a
// 401/503 text body, or a dropped connection) becomes a thrown Error with a readable message
// instead of a silent JSON.parse rejection. JSON error responses ({error}) pass straight
// through, so existing `r.error` checks keep working.
async function http(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('network error — is the server reachable?'); }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(text.trim() || `${res.status} ${res.statusText}`);
  }
  return res.json();
}
const get = (url) => http(url);
const post = (url, body) =>
  http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

export const api = {
  hosts: () => get('/api/hosts'),
  status: () => get('/api/status'),
  history: () => get('/api/history'),
  host: (domain) => get(`/api/host?domain=${encodeURIComponent(domain)}`),
  saveHost: (domain, content) => post('/api/host/save', { domain, content }),
  importCsv: (csv, apply) => post(`/api/import?apply=${apply}`, { csv }),
  switch: (domain, path, target) => post('/api/switch', { domain, path, target }),
  switchBulk: (items, target) => post('/api/switch-bulk', { items, target }),
  setUpstream: (domain, path, which, value) => post('/api/host/upstream', { domain, path, which, value }),
  rename: (domain, newDomain) => post('/api/host/rename', { domain, newDomain }),
  renameRoute: (domain, path, newPath) => post('/api/host/route', { domain, path, newPath }),
  matchPath: (domain, path) => post('/api/host/match', { domain, path }),
  addHost: (domain) => post('/api/host/add', { domain }),
  addRoute: (domain, path) => post('/api/host/route/add', { domain, path }),
  delRoute: (domain, path) => post('/api/host/route/delete', { domain, path }),
  enable: (domain) => post('/api/enable', { domain }),
  disable: (domain) => post('/api/disable', { domain }),
  del: (domain) => post('/api/host/delete', { domain }),
  rollback: (hash) => post('/api/rollback', { hash }),
  reload: () => post('/api/reload', {}),
  configTest: () => post('/api/config-test', {}),
  metrics: () => get('/api/metrics'),
  appConfig: () => get('/api/config'),
  // raw file editor
  files: (path) => get(`/api/files?path=${encodeURIComponent(path || '')}`),
  file: (path) => get(`/api/file?path=${encodeURIComponent(path || '')}`),
  saveFile: (path, content) => post('/api/file/save', { path, content }),
};

export const fmtSize = (n) =>
  (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
