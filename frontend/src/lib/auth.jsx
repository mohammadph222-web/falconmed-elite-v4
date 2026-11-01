import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setPaymentRequiredHandler, setUnauthorizedHandler, tokenStore } from './api';

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

  /** After sign-up or a password change the server issues a new token (older sessions are signed out). */
  const replaceSession = useCallback((token, nextUser) => {
    tokenStore.set(token);
    setUser(nextUser);
    setStatus('signed_in');
  }, []);

  /** Re-read the signed-in user (e.g. after renaming the organisation). */
  const refreshUser = useCallback(async () => {
    const r = await api('/auth/me');
    setUser(r.data);
  }, []);

  // The trial or subscription ended while the app was open: re-read the user so the app locks.
  useEffect(() => {
    setPaymentRequiredHandler(() => refreshUser().catch(() => {}));
  }, [refreshUser]);

  const value = useMemo(
    () => ({ user, status, login, logout, retry, replaceSession, refreshUser }),
    [user, status, login, logout, retry, replaceSession, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
};
