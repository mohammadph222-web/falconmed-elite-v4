const RAW = import.meta.env.VITE_API_URL || 'http://localhost:5000';
export const API_ORIGIN = String(RAW).trim().replace(/\/+$/, '').replace(/\/api$/i, '');
const API = `${API_ORIGIN}/api`;

const TOKEN_KEY = 'fm.token';

export const tokenStore = {
  get() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable — session lasts until reload */
    }
  },
};

export class ApiError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

/**
 * fetch wrapper: JSON in/out, bearer token, timeout sized for Render's
 * free-tier cold start (~50 s), consistent ApiError on failure.
 */
export async function api(path, { method = 'GET', body, params, signal, timeout = 65_000 } = {}) {
  const url = new URL(`${API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && token) onUnauthorized();
      const e = json?.error;
      throw new ApiError(res.status, e?.message || `Request failed (${res.status})`, e?.code, e?.details);
    }
    return json;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal?.aborted) throw err;
    if (err?.name === 'TimeoutError' || ctrl.signal.reason?.name === 'TimeoutError') {
      throw new ApiError(0, 'The server took too long to respond. It may be waking up — try again in a moment.', 'TIMEOUT');
    }
    throw new ApiError(0, 'Cannot reach the server. Check your connection.', 'NETWORK');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
