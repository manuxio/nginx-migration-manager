import React, { useState, useEffect, useCallback } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { html } from '@codemirror/lang-html';

// Throws a readable Error on a non-JSON response (gateway error, 401/503 text, dropped
// connection) instead of a silent JSON.parse rejection; JSON {error} bodies pass through.
const j = async (url, opts) => {
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new Error('network error — is the server reachable?'); }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(text.trim() || `${res.status} ${res.statusText}`);
  }
  return res.json();
};
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
// pick syntax highlighting by file name: nginx for *.conf / nginx.conf / mime.types / extensionless,
// html for *.htm(l), plain otherwise.
const langFor = (name = '') =>
  /\.html?$/i.test(name) ? [html()]
    : (/\.(conf|types)$/i.test(name) || /(^|\/)nginx\.conf$/i.test(name) || !/\.[a-z0-9]+$/i.test(name)) ? [StreamLanguage.define(nginx)]
      : [];

export default function FileEditor({ onClose }) {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState([]);
  const [err, setErr] = useState(null);
  const [file, setFile] = useState(null);    // { path, content?, size, binary?, tooLarge? }
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const loadDir = useCallback((p) => {
    setErr(null);
    j(`/api/files?path=${encodeURIComponent(p)}`).then((r) => {
      if (r.error) return setErr(r.error);
      setDir(r.path); setEntries(r.entries);
    }).catch((e) => setErr(e.message || 'failed to list directory'));
  }, []);
  useEffect(() => { loadDir(''); }, [loadDir]);

  const openFile = (p) => {
    setResult(null); setErr(null);
    j(`/api/file?path=${encodeURIComponent(p)}`).then((r) => {
      if (r.error) return setErr(r.error);
      setFile(r); setContent(r.content || ''); setDirty(false);
    }).catch((e) => setErr(e.message || 'failed to open file'));
  };

  const save = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await j('/api/file/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, content }),
      });
      setResult(r);
      if (!r.error) setDirty(false);
    } catch (e) {
      setResult({ error: e.message || String(e) });
    } finally { setBusy(false); }
  };

  const childOf = (e) => (dir ? `${dir}/${e.name}` : e.name);
  const up = dir ? dir.split('/').slice(0, -1).join('/') : null;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 1100 }}>
        <div className="bar">
          <h2 style={{ margin: 0 }}>Config files</h2>
          <code className="muted">/etc/nginx/{dir}</code>
          <span className="badge b-skip-manual" title="Raw editor — saving a broken file can stop nginx loading on the next reload.">⚠ raw — can break nginx</span>
          <button className="ghost sm right" onClick={onClose}>Close</button>
        </div>

        <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
          <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #262b36', paddingRight: 8, overflow: 'auto', maxHeight: '64vh' }}>
            {dir && <div className="fl" onClick={() => loadDir(up)}>📁 ..</div>}
            {entries.map((e) => (
              <div key={e.name} className="fl" title={e.name}
                onClick={() => (e.dir ? loadDir(childOf(e)) : openFile(childOf(e)))}
                style={{ fontWeight: file && !e.dir && file.path === childOf(e) ? 700 : 400 }}>
                {e.dir ? '📁' : '📄'} {e.name}
                {!e.dir && <span className="muted" style={{ float: 'right', fontSize: 11 }}>{fmtSize(e.size)}</span>}
              </div>
            ))}
            {err && <div className="banner fail" style={{ marginTop: 8 }}>{err}</div>}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {!file && <p className="muted">Select a file on the left to edit.</p>}
            {file && file.tooLarge && <div className="banner warn">File too large to edit ({fmtSize(file.size)}).</div>}
            {file && file.binary && <div className="banner warn">Binary file — not editable.</div>}
            {file && file.content != null && (
              <>
                <div className="bar" style={{ marginBottom: 8 }}>
                  <code>{file.path}</code>
                  {dirty && <span className="badge b-skip-manual">● unsaved</span>}
                  <button className="right" onClick={save} disabled={busy || !dirty}>Save</button>
                </div>
                <CodeMirror value={content} theme="dark" height="56vh"
                  extensions={langFor(file.path)} basicSetup={{ lineNumbers: true, highlightActiveLine: true }}
                  onChange={(v) => { setContent(v); setDirty(true); }} />
                {result && (result.error
                  ? <div className="banner fail" style={{ marginTop: 8 }}>{result.error}</div>
                  : <div className={`banner ${result.ok ? 'ok' : 'warn'}`} style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    Saved. <b>nginx -t:</b> {result.ok === true ? 'valid ✓ — reload nginx to apply.' : result.ok === null ? 'unknown (is the watcher running?)' : `problem ✗\n${result.message}`}
                  </div>)}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
