import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, KeyRound, MailCheck, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PASSWORD_RULES, passwordOk } from '../lib/password';
import { HOME } from '../lib/routes';
import { Spinner } from '../components/States';
import { Field, FormError } from '../components/Modal';
import { MfaStep } from '../components/TwoFactor';

/** Centred card used by every page reached from an email link. */
function AuthCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm animate-rise">
        <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand/15 text-brand-300 ring-1 ring-brand/30">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
        <h1 className="font-display text-2xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-mist-400">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

const BackToSignIn = () => (
  <Link to="/login" className="mt-6 inline-flex items-center gap-1.5 text-sm text-mist-400 hover:text-mist-200">
    <ArrowLeft className="h-4 w-4" /> Back to sign in
  </Link>
);

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(r.data.message);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard icon={KeyRound} title="Reset your password" subtitle="Enter your account email and we will send you a link to choose a new password.">
      {sent ? (
        <div role="status" className="rounded-xl border border-ok/30 bg-ok/10 px-3.5 py-3 text-sm text-ok-300">
          {sent} Check your inbox and spam folder. The link works for one hour.
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
          </Field>
          <FormError error={error} />
          <button className="btn-primary w-full py-3" disabled={busy}>
            {busy ? <Spinner className="h-4 w-4 text-white" /> : <ArrowRight className="h-4 w-4" />} Send reset link
          </button>
        </form>
      )}
      <BackToSignIn />
    </AuthCard>
  );
}

/** Reached from a reset or invitation email. Signs the person in once the password is set. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { replaceSession } = useAuth();
  const navigate = useNavigate();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState(null);
  const valid = passwordOk(next) && next === confirm;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: next } });
      // Two-factor sign-in is on: the password is saved, and the code is still needed to sign in.
      if (r.data.mfaRequired) {
        setMfaToken(r.data.mfaToken);
        setBusy(false);
        return;
      }
      replaceSession(r.data.token, r.data.user);
      navigate(HOME[r.data.user.role], { replace: true });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthCard icon={XCircle} title="Link incomplete" subtitle="Open the link from your email again, or request a new one.">
        <Link to="/forgot-password" className="btn-primary w-full py-3">Request a new link</Link>
        <BackToSignIn />
      </AuthCard>
    );
  }

  if (mfaToken) {
    return (
      <AuthCard icon={KeyRound} title="Password saved" subtitle="Two-factor sign-in is on for this account, so confirm it is you.">
        <MfaStep mfaToken={mfaToken} />
      </AuthCard>
    );
  }

  return (
    <AuthCard icon={KeyRound} title="Choose your password" subtitle="You will be signed in straight away. Every other session is signed out.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password">
          <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} required autoComplete="new-password" autoFocus />
        </Field>
        <p className="-mt-2 flex flex-wrap gap-x-3 text-xs">
          {PASSWORD_RULES.map(([ok, label]) => (
            <span key={label} className={ok(next) ? 'text-ok-300' : 'text-mist-500'}>
              {ok(next) ? '✓' : '○'} {label}
            </span>
          ))}
        </p>
        <Field label="Repeat it" error={confirm && confirm !== next ? 'The passwords do not match' : null}>
          <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        </Field>
        <FormError error={error} />
        {error && (
          <Link to="/forgot-password" className="block text-sm font-semibold text-brand-300 hover:text-brand-200">
            Request a new link
          </Link>
        )}
        <button className="btn-primary w-full py-3" disabled={busy || !valid}>
          {busy ? <Spinner className="h-4 w-4 text-white" /> : <ArrowRight className="h-4 w-4" />} Save password and sign in
        </button>
      </form>
    </AuthCard>
  );
}

/** Reached from the confirmation email. Works whether or not the person is signed in. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { user, refreshUser } = useAuth();
  const [state, setState] = useState(token ? 'checking' : 'error');
  const [error, setError] = useState(token ? null : { message: 'This link is incomplete. Open it from your email again.' });
  const once = useRef(false);

  useEffect(() => {
    if (!token || once.current) return;
    once.current = true; // the link is single use: never send it twice (React strict mode runs effects twice)
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => {
        setState('done');
        if (user) refreshUser().catch(() => {});
      })
      .catch((err) => {
        setError(err);
        setState('error');
      });
  }, [token, user, refreshUser]);

  return (
    <AuthCard
      icon={state === 'done' ? CheckCircle2 : state === 'error' ? XCircle : MailCheck}
      title={state === 'done' ? 'Email confirmed' : state === 'error' ? 'Could not confirm' : 'Confirming your email…'}
      subtitle={state === 'done' ? 'Thank you. Your account is fully set up.' : null}
    >
      {state === 'checking' && <Spinner className="h-6 w-6" />}
      {state === 'error' && <FormError error={error} />}
      {state !== 'checking' && (
        <Link to={user ? HOME[user.role] : '/login'} className="btn-primary mt-4 w-full py-3">
          {user ? 'Continue' : 'Sign in'} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </AuthCard>
  );
}
