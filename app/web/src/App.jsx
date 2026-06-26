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
  switch: (domain, target) => post('/api/switch', { domain, target }),
  switchBulk: (domains, target) => post('/api/switch-bulk', { domains, target }),
  enable: (domain) => post('/api/enable', { domain }),
  disable: (domain) => post('/api/disable', { domain }),
  del: (domain) => post('/api/host/delete', { domain }),
  rollback: (hash) => post('/api/rollback', { hash }),
  reload: () => post('/api/reload', {}),
  configTest: () => post('/api/config-test', {}),
};

// Migration framing: backend A = primary (address), backend B = alt (alt_address).
const liveLabel = (h) => (h.active === 'alt' ? 'B' : 'A');

function Badge({ kind, children }) {
  return <span className={`badge b-${kind}`}>{children}</span>;
}

export default function App() {
  const [hosts, setHosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [hist, setHist] = useState([]);
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState('');
  const [field, setField] = useState('any');
  const [statusFilter, setStatusFilter] = useState('all');

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
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function run(fn) { setBusy(true); try { await fn(); await refresh(); } finally { setBusy(false); } }

  const summary = useMemo(() => {
    const onA = hosts.filter((h) => h.enabled && h.active === 'primary').length;
    const onB = hosts.filter((h) => h.enabled && h.active === 'alt').length;
    const disabled = hosts.filter((h) => !h.enabled).length;
    const migratable = hosts.filter((h) => h.alt).length;
    const pct = migratable ? Math.round((hosts.filter((h) => h.active === 'alt').length / migratable) * 100) : 0;
    return { total: hosts.length, onA, onB, disabled, migratable, pct };
  }, [hosts]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return hosts.filter((h) => {
      if (statusFilter === 'A' && !(h.enabled && h.active === 'primary')) return false;
      if (statusFilter === 'B' && !(h.enabled && h.active === 'alt')) return false;
      if (statusFilter === 'disabled' && h.enabled) return false;
      if (statusFilter === 'noalt' && h.alt) return false;
      if (ql) {
        const cols = field === 'domain' ? [h.domain]
          : field === 'a' ? [h.primary]
          : field === 'b' ? [h.alt]
          : [h.domain, h.primary, h.alt];
        if (!cols.some((c) => (c || '').toLowerCase().includes(ql))) return false;
      }
      return true;
    });
  }, [hosts, q, field, statusFilter]);

  async function bulk(target) {
    const domains = filtered.filter((h) => h.managed).map((h) => h.domain);
    if (!domains.length) return;
    const label = target === 'alt' ? 'B (target)' : 'A (current)';
    if (!window.confirm(`Switch ${domains.length} filtered host(s) to backend ${label}?`)) return;
    await run(() => api.switchBulk(domains, target));
  }

  async function del(domain) {
    if (!window.confirm(`Delete host ${domain}?\n\nThe .conf file is removed and the change is committed. If this was a mistake, restore it from the History panel — Rollback to the checkpoint just before this delete.`)) return;
    await run(() => api.del(domain));
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
      if (!r.error) setPeek({ ...peek, content: editContent }); // mark clean
      await refresh();
    } finally { setBusy(false); }
  }

  function closePeek() {
    if (peek && editContent !== peek.content && !window.confirm('Discard unsaved edits to this file?')) return;
    setPeek(null);
  }

  // Pull the failing host file out of an nginx -t error message, e.g. ".../sites/app.test.conf:16".
  function brokenDomain(msg) {
    const m = /\/sites\/([A-Za-z0-9._-]+?)\.conf(?:\.disabled)?\b/.exec(msg || '');
    return m ? m[1] : null;
  }

  async function rollback(c) {
    if (!window.confirm(`Roll back the WHOLE config to ${c.hash} — "${c.message}"?\n\nEvery change made AFTER this checkpoint will be discarded and nginx reloaded. This cannot be undone from the UI.`)) return;
    const r = await api.rollback(c.hash);
    if (r && r.error) { window.alert(`Rollback failed: ${r.error}`); return; }
    await refresh();
  }

  async function testConfig() {
    setBusy(true);
    try { setTestResult(await api.configTest()); } finally { setBusy(false); }
  }

  async function preview() { setBusy(true); try { setPlan(await api.importCsv(csv, false)); } finally { setBusy(false); } }
  async function apply() { setBusy(true); try { const r = await api.importCsv(csv, true); setPlan(r); await refresh(); } finally { setBusy(false); } }
  async function onFile(e) { const f = e.target.files[0]; if (f) setCsv(await f.text()); }

  const chip = (key, label) => (
    <span className={`chip ${statusFilter === key ? 'active' : ''}`} onClick={() => setStatusFilter(key)}>{label}</span>
  );

  return (
    <div className="wrap">
      <h1>nginx-managed — migration cockpit</h1>
      <p className="sub">Cut hosts from <b>backend A</b> (address) to <b>backend B</b> (alt_address). Hand edits preserved · no mass delete.</p>

      {status && (
        <div className={`banner ${status.ok ? 'ok' : 'fail'}`}>
          {status.ok ? '✓ nginx config valid — ' : '✗ nginx reload problem — '}{status.message}
          {!status.ok && brokenDomain(status.message) && (
            <>{' '}<button className="ghost sm" onClick={() => openPeek(brokenDomain(status.message))}>Edit {brokenDomain(status.message)}.conf</button></>
          )}
        </div>
      )}

      <div className="card">
        <div className="bar">
          <div className="stat"><b>{summary.total}</b><span>hosts</span></div>
          <div className="stat"><b className="cA">{summary.onA}</b><span>on A</span></div>
          <div className="stat"><b className="cB">{summary.onB}</b><span>on B (migrated)</span></div>
          <div className="stat"><b>{summary.disabled}</b><span>disabled</span></div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div className="progress"><div style={{ width: `${summary.pct}%` }} /></div>
            <span className="muted" style={{ fontSize: 12 }}>{summary.pct}% of {summary.migratable} migratable hosts on B</span>
          </div>
          <button className="ghost" onClick={() => run(async () => {})} disabled={busy}>Refresh</button>
          <button className="ghost" onClick={testConfig} disabled={busy}>Test config</button>
          <button className="ghost" onClick={() => run(api.reload)} disabled={busy}>Reload nginx</button>
        </div>
        {testResult && (
          <div className={`banner ${testResult.ok ? 'ok' : 'fail'}`} style={{ marginTop: 12, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            <b>nginx -t:</b> {testResult.ok === true ? 'valid ✓' : testResult.ok === null ? 'unknown' : 'FAILED ✗'}
            {'\n'}{testResult.message}
            {testResult.ok === false && brokenDomain(testResult.message) && (
              <>{'\n'}<button className="ghost sm" onClick={() => openPeek(brokenDomain(testResult.message))}>Edit {brokenDomain(testResult.message)}.conf</button></>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <div className="bar" style={{ marginBottom: 12 }}>
          <input className="search" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="any">any column</option>
            <option value="domain">host</option>
            <option value="a">backend A</option>
            <option value="b">backend B</option>
          </select>
          <div className="row" style={{ gap: 6 }}>
            {chip('all', 'all')}{chip('A', 'on A')}{chip('B', 'on B')}{chip('disabled', 'disabled')}{chip('noalt', 'no B')}
          </div>
          <span className="muted right">{filtered.length} shown</span>
        </div>
        <div className="bar" style={{ marginBottom: 10 }}>
          <span className="muted">Bulk (applies to {filtered.filter((h) => h.managed).length} filtered managed hosts):</span>
          <button onClick={() => bulk('alt')} disabled={busy}>Cut over → B</button>
          <button className="ghost" onClick={() => bulk('primary')} disabled={busy}>Roll back → A</button>
          <a className="right" href="/api/download-all"><button className="ghost sm">Download all (.tar.gz)</button></a>
          <a href="/api/export"><button className="ghost sm">Export CSV</button></a>
        </div>

        <table>
          <thead>
            <tr><th>Host</th><th>Backend A</th><th>Backend B</th><th>Live</th><th>State</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {filtered.map((h) => {
              const hasAlt = !!h.alt;
              return (
                <tr key={h.file} style={{ opacity: h.enabled ? 1 : 0.5 }}>
                  <td><code>{h.domain}</code>{!h.managed && <> <Badge kind="manual">manual</Badge></>}</td>
                  <td><code className={h.active === 'primary' ? 'cA' : 'muted'}>{h.primary || '—'}</code></td>
                  <td><code className={h.active === 'alt' ? 'cB' : 'muted'}>{h.alt || '—'}</code></td>
                  <td><Badge kind={h.active === 'alt' ? 'skip-manual' : 'managed'}>{liveLabel(h)}</Badge></td>
                  <td>{h.enabled ? <span className="muted">on</span> : <Badge kind="disabled">off</Badge>}</td>
                  <td>
                    <div className="row">
                      <button className="ghost sm" disabled={busy || !h.managed || h.active === 'primary'} onClick={() => run(() => api.switch(h.domain, 'primary'))}>→ A</button>
                      <button className="ghost sm" disabled={busy || !h.managed || !hasAlt || h.active === 'alt'} onClick={() => run(() => api.switch(h.domain, 'alt'))}>→ B</button>
                      <button className="ghost sm" onClick={() => openPeek(h.domain)}>Peek</button>
                      {h.enabled
                        ? <button className="ghost sm" disabled={busy} onClick={() => run(() => api.disable(h.domain))}>Disable</button>
                        : <button className="ghost sm" disabled={busy} onClick={() => run(() => api.enable(h.domain))}>Enable</button>}
                      <a className="sm" href={`/api/download?domain=${encodeURIComponent(h.domain)}`}><button className="ghost sm">↓</button></a>
                      <button className="ghost sm danger" disabled={busy} onClick={() => del(h.domain)}>Delete</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={6} className="muted">No hosts match. {hosts.length === 0 ? 'Import a CSV below.' : ''}</td></tr>}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 8 }}>Delete removes a single host (committed — restore via Rollback). Disable pauses without deleting. Bulk import never deletes. A = primary/current, B = alt/target.</p>
      </div>

      <div className="card">
        <h2 onClick={() => setShowImport((v) => !v)} style={{ cursor: 'pointer' }}>{showImport ? '▾' : '▸'} Bulk import / update CSV</h2>
        {showImport && (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <input type="file" accept=".csv,text/csv" onChange={onFile} />
              <span className="muted">"domain","address","port","alt_address","alt_port" — ports default 80; cutover keeps your active selection</span>
            </div>
            <textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'"app.example.com","10.0.0.10","8080","10.0.1.10","8080"'} />
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
        <p className="muted" style={{ marginTop: -4 }}>Rollback restores the whole config to that checkpoint and <b>discards every change made after it</b>.</p>
        <table>
          <thead><tr><th>Commit</th><th>Timestamp</th><th>Change</th><th>Action</th></tr></thead>
          <tbody>
            {hist.map((c, i) => (
              <tr key={c.hash}>
                <td><code>{c.hash}</code>{i === 0 && <> <span className="muted">(current)</span></>}</td>
                <td className="muted">{c.date}</td>
                <td>{c.message}</td>
                <td><button className="ghost sm" disabled={busy || i === 0} onClick={() => rollback(c)}>Rollback</button></td>
              </tr>
            ))}
            {hist.length === 0 && <tr><td colSpan={4} className="muted">No commits yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {peek && (
        // Close only when the press STARTS on the backdrop itself — so a drag-select that
        // ends on the backdrop (mouseup outside the textarea) no longer closes the editor.
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closePeek(); }}>
          <div className="modal">
            <div className="bar">
              <h2 style={{ margin: 0 }}>Edit <code>{peek.file}</code></h2>
              <span className="muted">A=<code>{peek.primary || '—'}</code> · B=<code>{peek.alt || '—'}</code> · live=<b>{peek.active === 'alt' ? 'B' : 'A'}</b></span>
              <a className="right" href={`/api/download?domain=${encodeURIComponent(peek.domain)}`}><button className="ghost sm">Download</button></a>
              <button className="ghost sm" onClick={closePeek}>Close</button>
            </div>
            <textarea className="editor" value={editContent} spellCheck={false} onChange={(e) => setEditContent(e.target.value)} />
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={saveHost} disabled={busy || editContent === peek.content}>Save &amp; commit</button>
              <span className="muted">Saving writes the file, commits a checkpoint, then runs nginx -t.</span>
            </div>
            {saveMsg && (saveMsg.error
              ? <div className="banner fail" style={{ marginTop: 10 }}>{saveMsg.error}</div>
              : <div className={`banner ${saveMsg.ok ? 'ok' : 'fail'}`} style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                  Saved &amp; committed. <b>nginx -t:</b> {saveMsg.ok === true ? 'valid ✓' : saveMsg.ok === null ? 'unknown' : 'FAILED ✗'}{'\n'}{saveMsg.message}
                </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
