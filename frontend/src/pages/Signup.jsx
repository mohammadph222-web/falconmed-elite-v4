import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, CheckCircle2, FileUp, ShieldCheck, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Spinner } from '../components/States';
import { Field, FormError } from '../components/Modal';

const RULES = [
  [(p) => p.length >= 8, '8+ characters'],
  [(p) => /[A-Za-z]/.test(p), 'a letter'],
  [(p) => /\d/.test(p), 'a number'],
];

export default function Signup() {
  const { replaceSession } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ organisationName: '', fullName: '', email: '', password: '', acceptTerms: false, website: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const strong = RULES.every(([ok]) => ok(form.password));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api('/auth/signup', { method: 'POST', body: form });
      replaceSession(r.data.token, r.data.user);
      navigate('/network', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <div className="relative hidden overflow-hidden border-r border-ink-700/60 lg:flex lg:flex-col lg:justify-center lg:p-12">
        <div className="pointer-events-none absolute -left-32 top-1/4 h-[480px] w-[480px] rounded-full bg-brand/20 blur-3xl" />
        <div className="relative max-w-md">
          <div className="label">Free 14-day trial · no card needed</div>
          <h1 className="mt-3 font-display text-4xl font-semibold leading-tight tracking-tight text-white">
            Your pharmacy queue, <span className="text-brand-300">measured</span> in minutes.
          </h1>
          <ol className="mt-10 space-y-5">
            {[
              [Building2, 'Add your branches', 'Name, city and number of counters.'],
              [Users, 'Invite your team', 'Each person gets a temporary password and their own view.'],
              [FileUp, 'Bring your data', 'Import an export from your queue system, or try the simulator.'],
            ].map(([Icon, title, body], i) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink-800 text-brand-300 ring-1 ring-ink-600">
                  <Icon className="h-4 w-4" />
                </span>
                <div>
                  <div className="text-sm font-semibold text-white">
                    {i + 1}. {title}
                  </div>
                  <div className="text-sm text-mist-400">{body}</div>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-10 flex items-start gap-2 text-xs text-mist-500">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Your organisation’s data is kept separate from every other organisation. FalconMed never stores patient names.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md animate-rise">
          <h2 className="font-display text-2xl font-semibold text-white">Create your organisation</h2>
          <p className="mt-1 text-sm text-mist-400">You will be its admin. It takes under a minute.</p>

          <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
            <Field label="Pharmacy or group name">
              <input className="input" value={form.organisationName} onChange={set('organisationName')} maxLength={80} required placeholder="e.g. Al Noor Pharmacies" autoComplete="organization" />
            </Field>
            <Field label="Your name">
              <input className="input" value={form.fullName} onChange={set('fullName')} maxLength={80} required autoComplete="name" />
            </Field>
            <Field label="Work email" hint="You will sign in with this.">
              <input type="email" className="input" value={form.email} onChange={set('email')} maxLength={120} required autoComplete="email" placeholder="name@pharmacy.ae" />
            </Field>
            <Field label="Password">
              <input type="password" className="input" value={form.password} onChange={set('password')} required autoComplete="new-password" />
            </Field>
            <p className="-mt-2 flex flex-wrap gap-x-3 text-xs">
              {RULES.map(([ok, label]) => (
                <span key={label} className={ok(form.password) ? 'text-ok-300' : 'text-mist-500'}>
                  {ok(form.password) ? '✓' : '○'} {label}
                </span>
              ))}
            </p>
            {/* Hidden from people; bots tend to fill every field. */}
            <input type="text" name="website" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            <label className="flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-3.5 text-sm text-mist-300">
              <input type="checkbox" checked={form.acceptTerms} onChange={set('acceptTerms')} className="mt-0.5 h-4 w-4 accent-[#2563a8]" />
              <span>I will use FalconMed to evaluate my pharmacy’s queue performance and will not upload patient names or other identifiers.</span>
            </label>
            <FormError error={error} />
            <button className="btn-primary w-full py-3" disabled={busy || !strong || !form.acceptTerms}>
              {busy ? <Spinner className="h-4 w-4 text-white" /> : <ArrowRight className="h-4 w-4" />}
              {busy ? 'Creating…' : 'Create organisation and start trial'}
            </button>
          </form>

          <ul className="mt-6 space-y-1.5 text-xs text-mist-500">
            {['14 days free, everything included', 'Add as many branches and team members as you need', 'Every feature: dashboards, live queue, imports and settings'].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-ok-300" /> {t}
              </li>
            ))}
          </ul>
          <p className="mt-8 text-center text-sm text-mist-400">
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-brand-300 hover:text-brand-200">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
