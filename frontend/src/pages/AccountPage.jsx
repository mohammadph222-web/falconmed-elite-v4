import { useState } from 'react';
import { KeyRound, Lock, LogOut, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/format';
import { PageHeader, Panel } from '../components/ui';
import { Spinner } from '../components/States';
import { Field, FormError } from '../components/Modal';

const RULES = [
  [(p) => p.length >= 8, 'At least 8 characters'],
  [(p) => /[A-Za-z]/.test(p), 'A letter'],
  [(p) => /\d/.test(p), 'A number'],
];

function PasswordForm({ onDone, submitLabel = 'Change password', currentLabel = 'Current password' }) {
  const { replaceSession } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const valid = RULES.every(([ok]) => ok(next)) && next === confirm && current;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      replaceSession(r.data.token, r.data.user);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={currentLabel}>
        <input type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <Field label="New password">
        <input type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} required />
      </Field>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {RULES.map(([ok, label]) => (
          <li key={label} className={ok(next) ? 'text-ok-300' : 'text-mist-500'}>
            {ok(next) ? '✓' : '○'} {label}
          </li>
        ))}
      </ul>
      <Field label="Confirm new password" error={confirm && confirm !== next ? 'The two passwords do not match' : null}>
        <input type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </Field>
      <FormError error={error} />
      {done && <p className="text-sm text-ok-300">Password changed. Other devices have been signed out.</p>}
      <button className="btn-primary w-full" disabled={!valid || busy}>
        {busy ? <Spinner className="h-4 w-4 text-white" /> : <KeyRound className="h-4 w-4" />} {submitLabel}
      </button>
    </form>
  );
}

/** Full-screen step shown after signing in with a temporary password. */
export function ForcedPasswordChange() {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm animate-rise">
        <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand/15 text-brand-300 ring-1 ring-brand/30">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <h1 className="font-display text-2xl font-semibold text-white">Choose your password</h1>
        <p className="mt-1 text-sm text-mist-400">
          Welcome, {user.name}. You signed in with a temporary password from your administrator. Choose your own to continue.
        </p>
        <div className="mt-8">
          <PasswordForm submitLabel="Save and continue" currentLabel="Temporary password" />
        </div>
        <button onClick={logout} className="mt-6 flex items-center gap-1.5 text-xs text-mist-500 hover:text-mist-300">
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { user } = useAuth();
  return (
    <>
      <PageHeader eyebrow="My account" title={user.name} subtitle={user.email} />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Panel title="Profile" subtitle="Managed by your organisation admin">
          <dl className="space-y-3 text-sm">
            {[
              ['Organisation', user.orgName],
              ['Role', ROLE_LABEL[user.role]],
              ['Branch', user.branchName],
              ['Counter', user.counterNo],
              ['Email', user.email],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b border-ink-700/50 pb-3 last:border-0 last:pb-0">
                  <dt className="text-mist-400">{k}</dt>
                  <dd className="text-right font-medium text-white">{v}</dd>
                </div>
              ))}
          </dl>
        </Panel>
        <Panel title="Password" subtitle="Changing it signs you out on every other device">
          {user.demoProtected ? (
            <div className="flex items-start gap-3 rounded-xl border border-ink-600 bg-ink-900 p-4 text-sm text-mist-300">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-mist-400" />
              This is a shared demo account, so its password stays the same for everyone. In your own organisation every user can
              change their password here.
            </div>
          ) : (
            <PasswordForm />
          )}
        </Panel>
      </div>
    </>
  );
}
