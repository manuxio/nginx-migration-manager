// Shared application state: the host list, nginx status, git history, live metrics and the
// raw-editor feature flag — fetched once and refreshed centrally. `run()` wraps a mutating
// call in a busy flag + refresh (immediate, then again after the watcher settles its pending
// state). Pages consume this via useAppData(); the global error surfaces as a layout banner.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './client.js';

const AppDataContext = createContext(null);
export const useAppData = () => useContext(AppDataContext);

export default function AppDataProvider({ children }) {
  const [hosts, setHosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [hist, setHist] = useState([]);
  const [served, setServed] = useState('');
  const [head, setHead] = useState('');
  const [metrics, setMetrics] = useState(null);
  const [editorEnabled, setEditorEnabled] = useState(false);
  const [brand, setBrand] = useState('nginx-managed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [h, s, hi] = await Promise.all([api.hosts(), api.status(), api.history()]);
      setHosts(h.hosts || []);
      setStatus(s);
      setHist(hi.history || []);
      setServed(hi.served || '');
      setHead(hi.head || '');
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // poll live nginx throughput (stub_status via the app); independent of the host refresh
  useEffect(() => {
    let alive = true;
    const tick = () => api.metrics().then((m) => { if (alive) setMetrics(m); }).catch(() => {});
    tick();
    const h = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(h); };
  }, []);

  // one-time: feature flags + brand name (FILE_EDITOR / APP_NAME)
  useEffect(() => {
    api.appConfig().then((c) => {
      setEditorEnabled(!!c.editor);
      if (c.brand) setBrand(c.brand);
    }).catch(() => {});
  }, []);

  // keep the browser tab title in sync with the brand
  useEffect(() => { document.title = brand; }, [brand]);

  const run = useCallback(async (fn) => {
    setBusy(true);
    try { await fn(); await refresh(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
    setTimeout(refresh, 1400); // pick up the watcher's pending/test result
  }, [refresh]);

  const value = useMemo(() => ({
    hosts, status, hist, served, head, metrics, editorEnabled, brand,
    busy, error, loaded, setError, refresh, run, api,
  }), [hosts, status, hist, served, head, metrics, editorEnabled, brand, busy, error, loaded, refresh, run]);

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}
