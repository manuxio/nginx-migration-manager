import React, { useEffect, useState, useCallback, useMemo } from 'react';

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

const api = {
  hosts: () => fetch('/api/hosts').then((r) => r.json()),
  status: () => fetch('/api/status').then((r) => r.json()),
  history: () => fetch('/api/history').then((r) => r.json()),
  host: (domain) => fetch(`/api/host?domain=${encodeURIComponent(domain)}`).then((r) => r.json()),
  saveHost: (domain, content) => post('/api/host/save', { domain, content }),
  importCsv: (csv, apply) =>
    fetch(`/api/import?apply=${apply}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) }).then((r) => r.json()),
  switch: (domain, path, target) => post('/api/switch', { domain, path, target }),
  switchBulk: (items, target) => post('/api/switch-bulk', { items, target }),
  setUpstream: (domain, path, which, value) => post('/api/host/upstream', { domain, path, which, value }),
  rename: (domain, newDomain) => post('/api/host/rename', { domain, newDomain }),
  renameRoute: (domain, path, newPath) => post('/api/host/route', { domain, path, newPath }),
  addHost: (domain) => post('/api/host/add', { domain }),
  addRoute: (domain, path) => post('/api/host/route/add', { domain, path }),
  delRoute: (domain, path) => post('/api/host/route/delete', { domain, path }),
  enable: (domain) => post('/api/enable', { domain }),
  disable: (domain) => post('/api/disable', { domain }),
  del: (domain) => post('/api/host/delete', { domain }),
  rollback: (hash) => post('/api/rollback', { hash }),
  reload: () => post('/api/reload', {}),
  configTest: () => post('/api/config-test', {}),
};

const Badge = ({ kind, children }) => <span className={`badge b-${kind}`}>{children}</span>;
const pathLabel = (p) => (p === '/' ? '/  (whole site)' : p);

export default function App() {
  const [hosts, setHosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [hist, setHist] = useState([]);
  const [served, setServed] = useState('');
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState('');
  const [field, setField] = useState('any');
  const [statusFilter, setStatusFilter] = useState('all');

  const [editCell, setEditCell] = useState(null); // `${file}|${path}|${which}`
  const [editVal, setEditVal] = useState('');
  const [addingHost, setAddingHost] = useState(false);
  const [hostInput, setHostInput] = useState('');
  const [addHostErr, setAddHostErr] = useState(null);
  const [addPathFor, setAddPathFor] = useState(null); // host.file
  const [pathInput, setPathInput] = useState('');
  const [addPathErr, setAddPathErr] = useState(null);
  const [peek, setPeek] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [saveMsg, setSaveMsg] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const [plan, setPlan] = useState(null);

  const refresh = useCallback(async () => {
    const [h, s, hi] = await Promise.all([api.hosts(), api.status(), api.history()]);
    setHosts(h.hosts || []);
    setStatus(s);
    setHist(hi.history || []);
    setServed(hi.served || '');
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function run(fn) {
    setBusy(true);
    try { await fn(); await refresh(); } finally { setBusy(false); }
    setTimeout(refresh, 1400); // pick up the watcher's pending/test result
  }

  const allRoutes = useMemo(() => hosts.flatMap((h) => h.routes.map((route) => ({ host: h, route }))), [hosts]);

  const summary = useMemo(() => {
    let onA = 0; let onB = 0; let disabled = 0; let migratable = 0; let onBall = 0;
    for (const h of hosts) for (const r of h.routes) {
      if (r.active === 'alt') onBall++;
      if (!h.enabled) { disabled++; continue; }
      if (r.active === 'alt') onB++; else onA++;
      if (r.alt) migratable++;
    }
    const total = allRoutes.length;
    const pct = migratable ? Math.round((onBall / migratable) * 100) : 0;
    return { total, hostsN: hosts.length, onA, onB, disabled, migratable, pct };
  }, [hosts, allRoutes]);

  const filteredRoutes = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return allRoutes.filter(({ host, route }) => {
      if (statusFilter === 'A' && !(host.enabled && route.active === 'primary')) return false;
      if (statusFilter === 'B' && !(host.enabled && route.active === 'alt')) return false;
      if (statusFilter === 'disabled' && host.enabled) return false;
      if (statusFilter === 'noalt' && route.alt) return false;
      if (ql) {
        const cols = field === 'domain' ? [host.domain]
          : field === 'path' ? [route.path]
          : field === 'a' ? [route.primary]
          : field === 'b' ? [route.alt]
          : [host.domain, route.path, route.primary, route.alt];
        if (!cols.some((c) => (c || '').toLowerCase().includes(ql))) return false;
      }
      return true;
    });
  }, [allRoutes, q, field, statusFilter]);

  const groups = useMemo(() => {
    const m = new Map();
    for (const item of filteredRoutes) {
      if (!m.has(item.host.domain)) m.set(item.host.domain, { host: item.host, routes: [] });
      m.get(item.host.domain).routes.push(item.route);
    }
    return [...m.values()];
  }, [filteredRoutes]);

  const runningIndex = useMemo(
    () => hist.findIndex((c) => served && (c.hash.startsWith(served) || served.startsWith(c.hash))),
    [hist, served],
  );

  async function bulk(target) {
    const items = filteredRoutes.filter((x) => x.host.managed).map((x) => ({ domain: x.host.domain, path: x.route.path }));
    if (!items.length) return;
    const label = target === 'alt' ? 'B (target)' : 'A (current)';
    if (!window.confirm(`Switch ${items.length} filtered route(s) to backend ${label}?`)) return;
    await run(() => api.switchBulk(items, target));
  }

  async function del(domain) {
    if (!window.confirm(`Delete host ${domain} (all its routes)?\n\nThe .conf file is removed and committed. Restore from the History panel (Rollback) if this was a mistake.`)) return;
    await run(() => api.del(domain));
  }

  function startEdit(host, route, which) {
    setEditCell(`${host.file}|${route.path}|${which}`);
    setEditVal((which === 'primary' ? route.primary : route.alt) || '');
  }
  async function commitEdit(host, route, which) {
    if (editCell !== `${host.file}|${route.path}|${which}`) return;
    const val = editVal.trim();
    const orig = (which === 'primary' ? route.primary : route.alt) || '';
    setEditCell(null);
    if (val === orig) return;
    await run(() => api.setUpstream(host.domain, route.path, which, val).then((r) => { if (r && r.error) window.alert(`Edit failed: ${r.error}`); }));
  }

  // rename host (domain) / rename a route's path — double-click to edit
  function startEditHost(host) { setEditCell(`H|${host.file}`); setEditVal(host.domain); }
  async function commitEditHost(host) {
    if (editCell !== `H|${host.file}`) return;
    const val = editVal.trim(); setEditCell(null);
    if (!val || val === host.domain) return;
    await run(() => api.rename(host.domain, val).then((r) => { if (r && r.error) window.alert(`Rename failed: ${r.error}`); }));
  }
  function startEditPath(host, route) { setEditCell(`P|${host.file}|${route.path}`); setEditVal(route.path); }
  async function commitEditPath(host, route) {
    if (editCell !== `P|${host.file}|${route.path}`) return;
    const val = editVal.trim(); setEditCell(null);
    if (!val || val === route.path) return;
    await run(() => api.renameRoute(host.domain, route.path, val).then((r) => { if (r && r.error) window.alert(`Rename failed: ${r.error}`); }));
  }

  // switch EVERY route in a domain to A or B at once
  async function hostSwitch(host, target) {
    const items = host.routes.filter((r) => target === 'primary' || r.alt).map((r) => ({ domain: host.domain, path: r.path }));
    if (!items.length) return;
    await run(() => api.switchBulk(items, target));
  }

  // add a new host (default root route 127.0.0.1:80) / add a path to a host
  async function createHost() {
    const d = hostInput.trim().toLowerCase();
    if (!d) { setAddingHost(false); setAddHostErr(null); return; }
    setBusy(true);
    try {
      const r = await api.addHost(d);
      if (r && r.error) { setAddHostErr(r.error); return; }  // keep input open, show error
      setAddingHost(false); setHostInput(''); setAddHostErr(null); await refresh();
    } finally { setBusy(false); }
    setTimeout(refresh, 1400);
  }
  async function createPath(host) {
    const p = pathInput.trim();
    if (!p) { setAddPathFor(null); setAddPathErr(null); return; }
    setBusy(true);
    try {
      const r = await api.addRoute(host.domain, p);
      if (r && r.error) { setAddPathErr(r.error); return; }  // keep input open, show error
      setAddPathFor(null); setPathInput(''); setAddPathErr(null); await refresh();
    } finally { setBusy(false); }
    setTimeout(refresh, 1400);
  }
  async function delPath(host, route) {
    if (!window.confirm(`Delete path "${route.path}" from ${host.domain}?`)) return;
    await run(() => api.delRoute(host.domain, route.path).then((r) => { if (r && r.error) window.alert(`Delete failed: ${r.error}`); }));
  }

  async function openPeek(domain) {
    setBusy(true);
    try { const p = await api.host(domain); setPeek(p); setEditContent(p.content || ''); setSaveMsg(null); }
    finally { setBusy(false); }
  }
  async function saveHost() {
    setBusy(true);
    try {
      const r = await api.saveHost(peek.domain, editContent);
      setSaveMsg(r);
      if (!r.error) setPeek({ ...peek, content: editContent });
      await refresh();
    } finally { setBusy(false); }
  }
  function closePeek() {
    if (peek && editContent !== peek.content && !window.confirm('Discard unsaved edits to this file?')) return;
    setPeek(null);
  }
  function brokenDomain(msg) {
    const m = /\/sites\/([A-Za-z0-9._-]+?)\.conf(?:\.disabled)?\b/.exec(msg || '');
    return m ? m[1] : null;
  }
  async function rollback(c) {
    if (!window.confirm(`Roll back the WHOLE config to ${c.hash} — "${c.message}"?\n\nEvery change made AFTER this checkpoint is discarded and nginx reloaded.`)) return;
    const r = await api.rollback(c.hash);
    if (r && r.error) { window.alert(`Rollback failed: ${r.error}`); return; }
    await refresh();
  }
  async function testConfig() { setBusy(true); try { setTestResult(await api.configTest()); } finally { setBusy(false); } }
  async function preview() { setBusy(true); try { setPlan(await api.importCsv(csv, false)); } finally { setBusy(false); } }
  async function apply() { setBusy(true); try { const r = await api.importCsv(csv, true); setPlan(r); await refresh(); } finally { setBusy(false); } }
  async function onFile(e) { const f = e.target.files[0]; if (f) setCsv(await f.text()); }

  const chip = (key, label) => <span className={`chip ${statusFilter === key ? 'active' : ''}`} onClick={() => setStatusFilter(key)}>{label}</span>;

  // editable Backend A/B cell for a route
  const cell = (host, route, which) => {
    const val = which === 'primary' ? route.primary : route.alt;
    const live = host.enabled && route.active === which;
    const cls = live ? (which === 'primary' ? 'cA' : 'cB') : 'muted';
    const id = `${host.file}|${route.path}|${which}`;
    return editCell === id
      ? <input className="cellinput" autoFocus value={editVal}
          placeholder={which === 'alt' ? 'addr:port (blank = none)' : 'addr:port'}
          onChange={(e) => setEditVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitEdit(host, route, which); else if (e.key === 'Escape') setEditCell(null); }}
          onBlur={() => commitEdit(host, route, which)} />
      : <code className={cls} title="double-click to edit" style={{ cursor: 'text' }} onDoubleClick={() => host.managed && startEdit(host, route, which)}>{val || '—'}</code>;
  };

  return (
    <div className="wrap">
      <h1>nginx-managed — migration cockpit</h1>
      <p className="sub">Cut routes (<b>host</b> or <b>host/path/*</b>) from <b>backend A</b> to <b>backend B</b>. One file per domain · hand edits preserved · no mass delete.</p>

      {status && (
        <div className={`banner ${status.reload.ok ? 'ok' : 'fail'}`}>
          {status.reload.ok ? '✓ nginx serving — ' : '✗ nginx reload problem — '}{status.reload.message}
          {!status.reload.ok && brokenDomain(status.reload.message) && (
            <>{' '}<button className="ghost sm" onClick={() => openPeek(brokenDomain(status.reload.message))}>Edit {brokenDomain(status.reload.message)}.conf</button></>
          )}
        </div>
      )}
      {status && status.pending && (
        <div className={`banner ${status.test.ok ? 'warn' : 'fail'}`} style={{ whiteSpace: 'pre-wrap' }}>
          ⚠ Unreloaded changes pending. <b>nginx -t:</b>{' '}
          {status.test.ok
            ? 'valid ✓ — click “Reload nginx” to apply.'
            : <>FAILED ✗ — fix before reloading.{'\n'}{status.test.message}</>}
          {!status.test.ok && brokenDomain(status.test.message) && (
            <>{'\n'}<button className="ghost sm" onClick={() => openPeek(brokenDomain(status.test.message))}>Edit {brokenDomain(status.test.message)}.conf</button></>
          )}
        </div>
      )}

      <div className="card">
        <div className="bar">
          <div className="stat"><b>{summary.total}</b><span>routes / {summary.hostsN} hosts</span></div>
          <div className="stat"><b className="cA">{summary.onA}</b><span>on A</span></div>
          <div className="stat"><b className="cB">{summary.onB}</b><span>on B (migrated)</span></div>
          <div className="stat"><b>{summary.disabled}</b><span>disabled</span></div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div className="progress"><div style={{ width: `${summary.pct}%` }} /></div>
            <span className="muted" style={{ fontSize: 12 }}>{summary.pct}% of {summary.migratable} migratable routes on B</span>
          </div>
          <button className="ghost" onClick={() => run(async () => {})} disabled={busy}>Refresh</button>
          <button className="ghost" onClick={testConfig} disabled={busy}>Test config</button>
          <button className={status?.pending ? 'warn' : 'ghost'} onClick={() => run(api.reload)} disabled={busy} title={status?.pending ? 'Pending changes are not live until you reload' : 'Nothing pending'}>
            {status?.pending ? 'Reload nginx ●' : 'Reload nginx'}
          </button>
        </div>
        {testResult && (
          <div className={`banner ${testResult.ok ? 'ok' : 'fail'}`} style={{ marginTop: 12, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            <b>nginx -t:</b> {testResult.ok === true ? 'valid ✓' : testResult.ok === null ? 'unknown' : 'FAILED ✗'}{'\n'}{testResult.message}
          </div>
        )}
      </div>

      <div className="card">
        <div className="bar" style={{ marginBottom: 12 }}>
          <input className="search" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="any">any column</option>
            <option value="domain">host</option>
            <option value="path">path</option>
            <option value="a">backend A</option>
            <option value="b">backend B</option>
          </select>
          <div className="row" style={{ gap: 6 }}>
            {chip('all', 'all')}{chip('A', 'on A')}{chip('B', 'on B')}{chip('disabled', 'disabled')}{chip('noalt', 'no B')}
          </div>
          <span className="muted right">{filteredRoutes.length} routes shown</span>
        </div>
        <div className="bar" style={{ marginBottom: 10 }}>
          {addingHost
            ? <span className="row" style={{ gap: 6 }}>
                <input className="cellinput" autoFocus placeholder="new.example.com" value={hostInput}
                  onChange={(e) => { setHostInput(e.target.value); setAddHostErr(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') createHost(); else if (e.key === 'Escape') { setAddingHost(false); setHostInput(''); setAddHostErr(null); } }} />
                <button className="sm" onClick={createHost} disabled={busy}>Add host</button>
                <button className="ghost sm" onClick={() => { setAddingHost(false); setHostInput(''); setAddHostErr(null); }}>Cancel</button>
                {addHostErr && <span style={{ color: '#f5a3a3' }}>{addHostErr}</span>}
              </span>
            : <button className="ghost" onClick={() => { setAddingHost(true); setAddHostErr(null); }} disabled={busy}>+ Add host</button>}
          <span className="muted">·  Bulk ({filteredRoutes.filter((x) => x.host.managed).length} filtered routes):</span>
          <button onClick={() => bulk('alt')} disabled={busy}>Cut over → B</button>
          <button className="ghost" onClick={() => bulk('primary')} disabled={busy}>Roll back → A</button>
          <a className="right" href="/api/download-all"><button className="ghost sm">Download all (.tar.gz)</button></a>
          <a href="/api/export"><button className="ghost sm">Export CSV</button></a>
        </div>

        <table>
          <thead><tr><th>Host / path</th><th>Backend A</th><th>Backend B</th><th>Live</th><th>Actions</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.host.file}>
                <tr className="domainrow">
                  <td colSpan={5}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {editCell === `H|${g.host.file}`
                        ? <input className="cellinput" autoFocus value={editVal} style={{ minWidth: 200 }}
                            onChange={(e) => setEditVal(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitEditHost(g.host); else if (e.key === 'Escape') setEditCell(null); }}
                            onBlur={() => commitEditHost(g.host)} />
                        : <code><b title="double-click to rename host" style={{ cursor: 'text' }} onDoubleClick={() => startEditHost(g.host)}>{g.host.domain}</b></code>}
                      {!g.host.managed && <Badge kind="manual">manual</Badge>}
                      {!g.host.enabled && <Badge kind="disabled">disabled</Badge>}
                      <span className="row" style={{ gap: 6, marginLeft: 'auto' }}>
                        <button className="ghost sm" title="switch ALL routes to backend A" disabled={busy || !g.host.managed || !g.host.routes.some((r) => r.active === 'alt')} onClick={() => hostSwitch(g.host, 'primary')}>→ A</button>
                        <button className="ghost sm" title="switch ALL routes to backend B" disabled={busy || !g.host.managed || !g.host.routes.some((r) => r.alt && r.active === 'primary')} onClick={() => hostSwitch(g.host, 'alt')}>→ B</button>
                        <button className="ghost sm" title="add a path/route to this host" disabled={busy || !g.host.managed} onClick={() => { setAddPathFor(g.host.file); setPathInput(''); setAddPathErr(null); }}>+ path</button>
                        <button className="ghost sm" onClick={() => openPeek(g.host.domain)}>Peek / edit file</button>
                        <a className="sm" href={`/api/download?domain=${encodeURIComponent(g.host.domain)}`}><button className="ghost sm">↓</button></a>
                        {g.host.enabled
                          ? <button className="ghost sm" disabled={busy} onClick={() => run(() => api.disable(g.host.domain))}>Disable</button>
                          : <button className="ghost sm" disabled={busy} onClick={() => run(() => api.enable(g.host.domain))}>Enable</button>}
                        <button className="ghost sm danger" disabled={busy} onClick={() => del(g.host.domain)}>Delete</button>
                      </span>
                    </div>
                  </td>
                </tr>
                {addPathFor === g.host.file && (
                  <tr className="domainrow">
                    <td colSpan={5} style={{ paddingLeft: 22 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <input className="cellinput" autoFocus placeholder="/path/* (or / for whole site)" value={pathInput}
                          onChange={(e) => { setPathInput(e.target.value); setAddPathErr(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') createPath(g.host); else if (e.key === 'Escape') { setAddPathFor(null); setPathInput(''); setAddPathErr(null); } }} />
                        <button className="sm" onClick={() => createPath(g.host)} disabled={busy}>Add path</button>
                        <button className="ghost sm" onClick={() => { setAddPathFor(null); setPathInput(''); setAddPathErr(null); }}>Cancel</button>
                        {addPathErr ? <span style={{ color: '#f5a3a3' }}>{addPathErr}</span> : <span className="muted">new route → 127.0.0.1:80, no Backend B</span>}
                      </span>
                    </td>
                  </tr>
                )}
                {g.routes.map((route) => (
                  <tr key={route.path} style={{ opacity: g.host.enabled ? 1 : 0.5 }}>
                    <td style={{ paddingLeft: 22 }}>
                      {editCell === `P|${g.host.file}|${route.path}`
                        ? <input className="cellinput" autoFocus value={editVal} placeholder="/path/* or / for whole site"
                            onChange={(e) => setEditVal(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitEditPath(g.host, route); else if (e.key === 'Escape') setEditCell(null); }}
                            onBlur={() => commitEditPath(g.host, route)} />
                        : <code className="muted" title="double-click to edit path" style={{ cursor: 'text' }} onDoubleClick={() => g.host.managed && startEditPath(g.host, route)}>{pathLabel(route.path)}</code>}
                    </td>
                    <td>{cell(g.host, route, 'primary')}</td>
                    <td>{cell(g.host, route, 'alt')}</td>
                    <td><Badge kind={route.active === 'alt' ? 'skip-manual' : 'managed'}>{route.active === 'alt' ? 'B' : 'A'}</Badge></td>
                    <td>
                      <div className="row">
                        <button className="ghost sm" disabled={busy || !g.host.managed || route.active === 'primary'} onClick={() => run(() => api.switch(g.host.domain, route.path, 'primary'))}>→ A</button>
                        <button className="ghost sm" disabled={busy || !g.host.managed || !route.alt || route.active === 'alt'} onClick={() => run(() => api.switch(g.host.domain, route.path, 'alt'))}>→ B</button>
                        <button className="ghost sm danger" title="delete this path (delete the host to remove its last route)" disabled={busy || g.host.routes.length <= 1} onClick={() => delPath(g.host, route)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {groups.length === 0 && <tr><td colSpan={5} className="muted">No routes match. {hosts.length === 0 ? 'Import a CSV below.' : ''}</td></tr>}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 8 }}>Double-click the <b>host name</b>, a <b>path</b>, or a <b>Backend A/B</b> cell to edit it (Enter to save, Esc to cancel). Per-row → A / → B switch one route; the header → A / → B switch the whole domain. Delete/Disable/Download act on the whole domain file.</p>
      </div>

      <div className="card">
        <h2 onClick={() => setShowImport((v) => !v)} style={{ cursor: 'pointer' }}>{showImport ? '▾' : '▸'} Bulk import / update CSV</h2>
        {showImport && (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <input type="file" accept=".csv,text/csv" onChange={onFile} />
              <span className="muted">"domain[/path[/*]]","address","port","alt_address","alt_port" — rows grouped by domain into one file</span>
            </div>
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'"www.example.com","10.0.0.1","80","10.0.1.1","80"\n"www.example.com/api/*","10.0.0.5","8080","10.0.1.5","8080"'} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost" onClick={preview} disabled={busy || !csv.trim()}>Preview (dry run)</button>
              <button onClick={apply} disabled={busy || !csv.trim()}>Apply</button>
            </div>
            {plan && (
              <div style={{ marginTop: 14 }}>
                {plan.summary && (
                  <p className="muted">{plan.summary.create} create · {plan.summary.update} update · {plan.summary.unchanged} unchanged · {plan.summary['skip-manual']} manual-skipped · {plan.summary.invalid} invalid{plan.applied ? ' — applied' : ' — preview only'}</p>
                )}
                <table>
                  <thead><tr><th>Domain</th><th>Status</th><th>Detail</th></tr></thead>
                  <tbody>{plan.plan.map((p, i) => (<tr key={i}><td><code>{p.domain}</code></td><td><Badge kind={p.status}>{p.status}</Badge></td><td className="muted">{p.detail}</td></tr>))}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Change history (git) — last 50 commits · every action is committed</h2>
        <p className="muted" style={{ marginTop: -4 }}>
          <Badge kind="managed">● running</Badge> = the commit nginx is serving (last reload).{' '}
          Anything <Badge kind="skip-manual">pending</Badge> above it is committed but not live until you reload.{' '}
          Rollback restores the whole config to that checkpoint and <b>discards every change after it</b>.
        </p>
        <table>
          <thead><tr><th>Commit</th><th>Timestamp</th><th>Change</th><th>Action</th></tr></thead>
          <tbody>
            {hist.map((c, i) => {
              const isRunning = i === runningIndex;
              const isPending = runningIndex >= 0 && i < runningIndex;
              return (
                <tr key={c.hash} className={isRunning ? 'running' : ''}>
                  <td><code>{c.hash}</code>{i === 0 && <> <span className="muted">(latest)</span></>}{isRunning && <> <Badge kind="managed">● running</Badge></>}{isPending && <> <Badge kind="skip-manual">pending</Badge></>}</td>
                  <td className="muted">{c.date}</td>
                  <td>{c.message}</td>
                  <td><button className="ghost sm" disabled={busy || i === 0} onClick={() => rollback(c)}>Rollback</button></td>
                </tr>
              );
            })}
            {hist.length === 0 && <tr><td colSpan={4} className="muted">No commits yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {peek && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closePeek(); }}>
          <div className="modal">
            <div className="bar">
              <h2 style={{ margin: 0 }}>Edit <code>{peek.file}</code></h2>
              <span className="muted">{(peek.routes || []).length} route(s): {(peek.routes || []).map((r) => r.path).join(', ')}</span>
              <a className="right" href={`/api/download?domain=${encodeURIComponent(peek.domain)}`}><button className="ghost sm">Download</button></a>
              <button className="ghost sm" onClick={closePeek}>Close</button>
            </div>
            <textarea className="editor" value={editContent} spellCheck={false} onChange={(e) => setEditContent(e.target.value)} />
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={saveHost} disabled={busy || editContent === peek.content}>Save &amp; commit</button>
              <span className="muted">Saving writes the file, commits a checkpoint, and runs nginx -t. Not applied until you Reload.</span>
            </div>
            {saveMsg && (saveMsg.error
              ? <div className="banner fail" style={{ marginTop: 10 }}>{saveMsg.error}</div>
              : <div className={`banner ${saveMsg.ok ? 'warn' : 'fail'}`} style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                  Saved &amp; committed (pending reload). <b>nginx -t:</b> {saveMsg.ok === true ? 'valid ✓' : saveMsg.ok === null ? 'unknown' : 'FAILED ✗'}{'\n'}{saveMsg.message}
                </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
