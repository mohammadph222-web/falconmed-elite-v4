import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(() => (tokenStore.get() ? 'checking' : 'signed_out'));

  const logout = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
    setStatus('signed_out');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  // Restore a session from a stored token (validated by the server, never trusted blindly).
  useEffect(() => {
    if (status !== 'checking') return;
    const ctrl = new AbortController();
    api('/auth/me', { signal: ctrl.signal })
      .then((r) => {
        setUser(r.data);
        setStatus('signed_in');
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        if (err.status === 401) logout();
        else setStatus('offline');
      });
    return () => ctrl.abort();
  }, [status, logout]);

  const login = useCallback(async (email, password) => {
    const r = await api('/auth/login', { method: 'POST', body: { email, password } });
    tokenStore.set(r.data.token);
    setUser(r.data.user);
    setStatus('signed_in');
    return r.data.user;
  }, []);

  const retry = useCallback(() => setStatus('checking'), []);

  const value = useMemo(() => ({ user, status, login, logout, retry }), [user, status, login, logout, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
