import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, BarChart3, Building2, Lock, Mail, MonitorSmartphone, Network, ShieldCheck, Timer } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/format';
import { Spinner } from '../components/States';
import { HOME } from '../lib/routes';
import { APP_VERSION } from '../lib/version';

const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || 'Demo@2026';
const ROLE_ICON = { pharmacist: MonitorSmartphone, manager: Building2, admin: Network };

/** Keep the server's order, grouped by organisation. */
function groupByOrg(accounts) {
  const groups = new Map();
  for (const a of accounts) {
    const key = a.orgName || 'Demo';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups.entries()];
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState([]);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => setWaking(true), 3500); // free-tier API cold start hint
    api('/auth/demo-accounts', { signal: ctrl.signal })
      .then((r) => setDemo(r.data))
      .catch(() => {})
      .finally(() => {
        clearTimeout(t);
        setWaking(false);
      });
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, []);

  const submit = async (e, creds) => {
    e?.preventDefault();
    const em = creds?.email ?? email;
    const pw = creds?.password ?? password;
    setError('');
    setBusy(true);
    try {
      const user = await login(em, pw);
      navigate(HOME[user.role], { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* story */}
      <div className="relative hidden overflow-hidden border-r border-ink-700/60 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -left-32 top-1/3 h-[480px] w-[480px] rounded-full bg-brand/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand shadow-lg shadow-brand/40">
            <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
              <path d="M8 22 L16 8 L24 22 M11.5 17 H20.5" stroke="#E8EEF8" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="font-display text-lg font-semibold text-white">FalconMed Elite</div>
            <div className="label">Pharmacy queue analytics</div>
          </div>
        </div>

        <div className="relative max-w-lg">
          <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight text-white">
            Every minute a patient waits, <span className="text-brand-300">measured</span>.
          </h1>
          <p className="mt-4 text-mist-300">
            From the queue machine to the counter to the network view: one definition for every KPI, calculated from real
            timestamps, scoped to each role.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              [Timer, 'Wait and service time from arrival, call and finish timestamps'],
              [BarChart3, 'Pharmacist, branch and network views from the same data'],
              [ShieldCheck, 'Server-side sign-in and role scoping; no patient names stored'],
            ].map(([Icon, text]) => (
              <li key={text} className="flex items-start gap-3 text-sm text-mist-200">
                <span className="rounded-lg bg-ink-800 p-1.5 text-brand-300 ring-1 ring-ink-600">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="pt-1">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative font-mono text-[11px] text-mist-500">v{APP_VERSION} · Demo environment with simulated data</p>
      </div>

      {/* form */}
      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm animate-rise">
          <h2 className="font-display text-2xl font-semibold text-white">Sign in</h2>
          <p className="mt-1 text-sm text-mist-400">Use your work account or a demo role below.</p>

          <form onSubmit={submit} className="mt-8 space-y-4">
            <label className="block">
              <span className="label">Email</span>
              <div className="relative mt-1.5">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-500" aria-hidden />
                <input
                  type="email"
                  autoComplete="username"
                  required
                  className="input pl-10"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@pharmacy.ae"
                />
              </div>
            </label>
            <label className="block">
              <span className="label">Password</span>
              <div className="relative mt-1.5">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mist-500" aria-hidden />
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  className="input pl-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            </label>

            {error && (
              <div role="alert" className="rounded-xl border border-crit/35 bg-crit/10 px-3.5 py-2.5 text-sm text-crit-300">
                {error}
              </div>
            )}

            <button className="btn-primary w-full py-3" disabled={busy}>
              {busy ? <Spinner className="h-4 w-4 text-white" /> : <ArrowRight className="h-4 w-4" />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="mt-10">
            <div className="label mb-3 flex items-center gap-2">
              <span className="h-px flex-1 bg-ink-700" /> Demo access <span className="h-px flex-1 bg-ink-700" />
            </div>
            {waking && <p className="mb-3 text-center text-xs text-mist-400">Waking the server — this can take up to a minute on the free tier…</p>}
            <div className="space-y-5">
              {groupByOrg(demo).map(([org, accounts], gi) => (
                <div key={org}>
                  <div className="mb-2 flex items-baseline justify-between gap-2 px-0.5">
                    <span className="truncate text-xs font-semibold text-mist-200">{org}</span>
                    {gi > 0 && <span className="shrink-0 text-[11px] text-mist-500">separate organisation</span>}
                  </div>
                  <div className="space-y-2">
                    {accounts.map((d) => {
                      const Icon = ROLE_ICON[d.role];
                      return (
                        <button
                          key={d.email}
                          disabled={busy}
                          onClick={() => submit(null, { email: d.email, password: DEMO_PASSWORD })}
                          className="group flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-3 text-left transition hover:border-brand/50 hover:bg-ink-800 disabled:opacity-50"
                        >
                          <span className="rounded-lg bg-brand/15 p-2 text-brand-300">
                            <Icon className="h-4 w-4" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-white">{ROLE_LABEL[d.role]}</span>
                            <span className="block truncate text-xs text-mist-400">
                              {d.name}
                              {d.branchName ? ` · ${d.branchName}` : ''}
                            </span>
                          </span>
                          <ArrowRight className="h-4 w-4 text-mist-500 transition group-hover:translate-x-0.5 group-hover:text-brand-300" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
