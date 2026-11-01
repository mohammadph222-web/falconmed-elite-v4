import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, Check, Copy, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/useSubmit';
import { Spinner } from './States';
import { Field, FormError } from './Modal';

const codeInput = (value, onChange, props = {}) => (
  <input
    className="input text-center font-mono text-lg tracking-[0.3em]"
    inputMode="numeric"
    autoComplete="one-time-code"
    maxLength={6}
    value={value}
    onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
    {...props}
  />
);

/** Second step of signing in: a code from the app, or a recovery code. */
export function MfaStep({ mfaToken, onCancel }) {
  const { completeMfa } = useAuth();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const verify = useSubmit(() => completeMfa(mfaToken, recovery ? { recoveryCode: code } : { code }));

  return (
    <form onSubmit={(e) => (e.preventDefault(), verify.run())} className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-brand/30 bg-brand/[0.07] p-3.5 text-sm text-mist-200">
        <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" />
        {recovery ? 'Enter one of the recovery codes you saved. Each one works once.' : 'Open your authenticator app and enter the 6-digit code for FalconMed Elite.'}
      </div>
      <Field label={recovery ? 'Recovery code' : 'Code'}>
        {recovery ? (
          <input className="input font-mono" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoFocus placeholder="xxxx-xxxx" />
        ) : (
          codeInput(code, setCode, { autoFocus: true })
        )}
      </Field>
      <FormError error={verify.error} />
      <button className="btn-primary w-full py-3" disabled={verify.busy || (recovery ? code.length < 8 : code.length !== 6)}>
        {verify.busy ? <Spinner className="h-4 w-4 text-white" /> : <ArrowRight className="h-4 w-4" />} Verify and sign in
      </button>
      <div className="flex justify-between text-xs">
        <button type="button" className="text-brand-300 hover:text-brand-200" onClick={() => (setRecovery((r) => !r), setCode(''))}>
          {recovery ? 'Use the authenticator app' : 'Lost your phone? Use a recovery code'}
        </button>
        {onCancel && (
          <button type="button" className="text-mist-500 hover:text-mist-300" onClick={onCancel}>
            Start again
          </button>
        )}
      </div>
    </form>
  );
}

function RecoveryCodes({ codes, onDone }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      /* clipboard blocked — the codes are still visible to copy by hand */
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-mist-300">
        Save these recovery codes somewhere safe, away from your phone. Each one signs you in once if you lose your phone. They are shown only now.
      </p>
      <ol className="grid grid-cols-2 gap-2 rounded-xl border border-ink-600 bg-ink-900 p-4 font-mono text-sm text-brand-200">
        {codes.map((c) => (
          <li key={c} className="select-all">{c}</li>
        ))}
      </ol>
      <div className="flex gap-2">
        <button className="btn-ghost flex-1" onClick={copy}>
          {copied ? <Check className="h-4 w-4 text-ok-300" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy codes'}
        </button>
        <button className="btn-primary flex-1" onClick={onDone}>I have saved them</button>
      </div>
    </div>
  );
}

/** Scan the QR code, confirm one code, then save the recovery codes. */
function Enrol({ onDone }) {
  const { refreshUser } = useAuth();
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const start = useSubmit(async () => {
    const r = await api('/auth/2fa/setup', { method: 'POST' });
    setSetup(r.data);
    setQr(await QRCode.toDataURL(r.data.otpauthUrl, { margin: 1, width: 192 }));
  });
  const enable = useSubmit(async () => {
    const r = await api('/auth/2fa/enable', { method: 'POST', body: { code } });
    setCodes(r.data.recoveryCodes);
  });
  useEffect(() => {
    start.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (codes) return <RecoveryCodes codes={codes} onDone={() => refreshUser().then(onDone)} />;
  if (!setup) return start.error ? <FormError error={start.error} /> : <Spinner className="h-6 w-6" />;
  return (
    <form onSubmit={(e) => (e.preventDefault(), enable.run())} className="space-y-4">
      <p className="text-sm text-mist-300">1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</p>
      <div className="flex flex-wrap items-center gap-4">
        {qr && <img src={qr} alt="QR code for your authenticator app" className="h-40 w-40 rounded-lg bg-white p-1" />}
        <div className="min-w-0 text-xs text-mist-400">
          Can’t scan? Enter this key:
          <div className="mt-1 select-all break-all font-mono text-sm text-mist-200">{setup.secret.match(/.{1,4}/g).join(' ')}</div>
        </div>
      </div>
      <Field label="2. Enter the 6-digit code it shows">{codeInput(code, setCode)}</Field>
      <FormError error={enable.error} />
      <button className="btn-primary w-full" disabled={enable.busy || code.length !== 6}>
        {enable.busy ? <Spinner className="h-4 w-4 text-white" /> : <ShieldCheck className="h-4 w-4" />} Turn on two-factor sign-in
      </button>
    </form>
  );
}

/** My account panel body: turn on, renew recovery codes, turn off. */
export function TwoFactorSettings() {
  const { user, refreshUser } = useAuth();
  const [mode, setMode] = useState(null); // 'enrol' | 'disable' | 'renew'
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const disable = useSubmit(async () => {
    await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
    await refreshUser();
    setMode(null);
  });
  const renew = useSubmit(async () => {
    const r = await api('/auth/2fa/recovery-codes', { method: 'POST', body: { code } });
    setCodes(r.data.recoveryCodes);
  });

  if (user.demoProtected) return <p className="text-sm text-mist-400">Shared demo accounts cannot use two-factor sign-in.</p>;
  if (codes) return <RecoveryCodes codes={codes} onDone={() => (setCodes(null), setMode(null), setCode(''), refreshUser())} />;
  if (mode === 'enrol') return <Enrol onDone={() => setMode(null)} />;
  if (!user.twoFactorEnabled) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-mist-300">Ask for a code from your phone as well as your password when you sign in. Recommended for admins.</p>
        <button className="btn-primary" onClick={() => setMode('enrol')}>
          <ShieldCheck className="h-4 w-4" /> Set up two-factor sign-in
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-ok-300">
        <ShieldCheck className="h-4 w-4" /> On · {user.recoveryCodesLeft} recovery code{user.recoveryCodesLeft === 1 ? '' : 's'} left
      </p>
      {mode === null && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => setMode('renew')}>New recovery codes</button>
          <button className="btn-ghost" onClick={() => setMode('disable')}>Turn off</button>
        </div>
      )}
      {mode === 'renew' && (
        <form onSubmit={(e) => (e.preventDefault(), renew.run())} className="space-y-3">
          <Field label="Code from your app">{codeInput(code, setCode, { autoFocus: true })}</Field>
          <FormError error={renew.error} />
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => setMode(null)}>Cancel</button>
            <button className="btn-primary" disabled={renew.busy || code.length !== 6}>Create new codes</button>
          </div>
        </form>
      )}
      {mode === 'disable' && (
        <form onSubmit={(e) => (e.preventDefault(), disable.run())} className="space-y-3">
          <Field label="Your password">
            <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="Code from your app">{codeInput(code, setCode)}</Field>
          <FormError error={disable.error} />
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => setMode(null)}>Cancel</button>
            <button className="btn-primary" disabled={disable.busy || !password || code.length !== 6}>Turn off</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Full-screen step for an admin whose organisation requires two-factor sign-in. */
export function ForcedTwoFactorSetup() {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md animate-rise">
        <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand/15 text-brand-300 ring-1 ring-brand/30">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <h1 className="font-display text-2xl font-semibold text-white">Set up two-factor sign-in</h1>
        <p className="mt-1 text-sm text-mist-400">{user.orgName} requires admins to confirm each sign-in with a code from their phone.</p>
        <div className="mt-8">
          <Enrol onDone={() => {}} />
        </div>
        <button onClick={logout} className="mt-6 flex items-center gap-1.5 text-xs text-mist-500 hover:text-mist-300">
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>
    </div>
  );
}
