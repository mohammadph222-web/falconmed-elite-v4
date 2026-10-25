import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * GET an endpoint, optionally polling. Keeps showing the last good data
 * while refreshing, pauses polling when the tab is hidden, and cancels
 * in-flight requests on change/unmount (no races, no leaks).
 */
export function useApi(path, params, { interval = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, meta: null, error: null, loading: enabled });
  const key = path && enabled ? `${path}?${JSON.stringify(params ?? {})}` : null;
  const ctrlRef = useRef(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const load = useCallback(async () => {
    if (!key) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await api(path, { params: paramsRef.current, signal: ctrl.signal });
      if (!ctrl.signal.aborted) setState({ data: r.data, meta: { scope: r.scope }, error: null, loading: false });
    } catch (err) {
      if (!ctrl.signal.aborted) setState((s) => ({ ...s, error: err, loading: false }));
    }
  }, [key, path]);

  useEffect(() => {
    if (!key) return undefined;
    setState((s) => ({ ...s, error: null })); // keep previous data visible while the new range loads
    load();
    return () => ctrlRef.current?.abort();
  }, [key, load]);

  useEffect(() => {
    if (!key || !interval) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, interval);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, interval, load]);

  return { ...state, reload: load };
}
