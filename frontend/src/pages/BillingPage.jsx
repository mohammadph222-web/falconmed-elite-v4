import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, CreditCard, ExternalLink, Mail } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { cn } from '../lib/format';
import { PageHeader, Panel } from '../components/ui';
import { Spinner } from '../components/States';
import { FormError } from '../components/Modal';

const SALES_EMAIL = import.meta.env.VITE_SALES_EMAIL || 'sales@falconmed.app';
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const limit = (n, noun) => (n === null ? `Unlimited ${noun}` : `Up to ${n} ${noun}`);

const STATUS_TEXT = {
  active: ['Active', 'ok'],
  trialing: ['Active · trial period', 'ok'],
  past_due: ['Payment overdue — Stripe is retrying', 'warn'],
  unpaid: ['Unpaid', 'crit'],
  canceled: ['Cancelled', 'crit'],
  incomplete: ['Waiting for first payment', 'warn'],
  incomplete_expired: ['First payment failed', 'crit'],
  paused: ['Paused', 'warn'],
};

/** Plan, usage and the way to subscribe or manage the subscription. Admins only. */
export default function BillingPage() {
  const { user, refreshUser } = useAuth();
  const [params] = useSearchParams();
  const billing = useApi('/billing');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const b = billing.data;

  const go = async (path, body, key) => {
    setBusy(key);
    setError(null);
    try {
      const r = await api(path, { method: 'POST', body });
      window.location.assign(r.data.url);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy('verify');
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      setNotice(`We sent a new confirmation link to ${user.email}.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const checkout = params.get('checkout');
  const subscribed = b && b.hasCustomer && b.status && b.status !== 'canceled' && b.status !== 'incomplete_expired';
  const [statusLabel, statusTone] = (b?.status && STATUS_TEXT[b.status]) || [null, null];

  return (
    <>
      <PageHeader eyebrow={`${user.orgName} · billing`} title="Plan and billing" subtitle="Choose a plan, update your card and download invoices." />

      {checkout === 'success' && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-xl border border-ok/30 bg-ok/10 px-4 py-3 text-sm text-ok-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Thank you — payment received. Your plan updates within a few seconds.{' '}
            <button className="font-semibold underline" onClick={() => Promise.all([billing.reload(), refreshUser()])}>
              Refresh
            </button>
          </span>
        </div>
      )}
      {b && !b.entitled && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl border border-crit/35 bg-crit/10 px-4 py-3 text-sm text-crit-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {b.entitlementReason === 'trial_ended'
              ? 'Your free trial has ended. Your data is safe — choose a plan below to keep using FalconMed.'
              : 'Your subscription is not active. Update your payment method or choose a plan to continue.'}{' '}
            You can still export your data from Settings.
          </span>
        </div>
      )}
      {!user.emailVerified && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-warn/[0.08] px-4 py-3 text-sm text-warn-300">
          <Mail className="h-4 w-4 shrink-0" />
          <span className="flex-1">Confirm your email address before subscribing. We sent a link to {user.email}.</span>
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={resend} disabled={busy === 'verify'}>
            {busy === 'verify' && <Spinner className="h-3.5 w-3.5" />} Send it again
          </button>
        </div>
      )}
      {notice && <p role="status" className="mb-4 text-sm text-ok-300">{notice}</p>}
      {error && (
        <div className="mb-4">
          <FormError error={error} />
        </div>
      )}

      {billing.error && !b ? (
        <Panel error={billing.error} onRetry={billing.reload} />
      ) : !b ? (
        <Spinner className="mx-auto my-24 h-7 w-7" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
            <Panel
              title="Current plan"
              right={
                subscribed && (
                  <button className="btn-ghost" onClick={() => go('/billing/portal', undefined, 'portal')} disabled={Boolean(busy)}>
                    {busy === 'portal' ? <Spinner className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />} Manage subscription
                    <ExternalLink className="h-3.5 w-3.5 opacity-60" />
                  </button>
                )
              }
            >
              <dl className="space-y-3 text-sm">
                {[
                  ['Plan', b.planLabel],
                  statusLabel && ['Status', <span key="s" className={cn(statusTone === 'ok' ? 'text-ok-300' : statusTone === 'warn' ? 'text-warn-300' : 'text-crit-300')}>{statusLabel}</span>],
                  b.plan === 'trial' && ['Trial ends', fmtDate(b.trialEndsAt)],
                  b.currentPeriodEnd && [b.cancelAtPeriodEnd ? 'Ends on' : 'Renews on', fmtDate(b.currentPeriodEnd)],
                ]
                  .filter(Boolean)
                  .map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-4 border-b border-ink-700/50 pb-3 last:border-0 last:pb-0">
                      <dt className="text-mist-400">{k}</dt>
                      <dd className="font-medium text-white">{v}</dd>
                    </div>
                  ))}
              </dl>
            </Panel>
            <Panel title="Usage">
              {[
                ['Active branches', b.usage.branches, b.limits.branches],
                ['Active team members', b.usage.users, b.limits.users],
              ].map(([label, used, max]) => (
                <div key={label} className="mb-4 last:mb-0">
                  <div className="flex justify-between text-sm">
                    <span className="text-mist-300">{label}</span>
                    <span className="tabular text-white">
                      {used} {max === null ? '' : `/ ${max}`}
                    </span>
                  </div>
                  {max !== null && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-700">
                      <div className={cn('h-full rounded-full', used >= max ? 'bg-warn' : 'bg-brand')} style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
                    </div>
                  )}
                </div>
              ))}
            </Panel>
          </div>

          {!subscribed && b.plan !== 'demo' && (
            <Panel title="Choose a plan" subtitle={b.billingEnabled ? 'Secure payment by Stripe. Cancel any time from “Manage subscription”.' : 'Online payment is not set up on this server yet.'}>
              <div className="grid gap-3 md:grid-cols-3">
                {b.plans.map((p) => (
                  <div key={p.id} className={cn('flex flex-col rounded-xl border p-4', p.id === 'pro' ? 'border-brand/50 bg-brand/[0.06]' : 'border-ink-700 bg-ink-900/60')}>
                    <div className="font-display text-lg font-semibold text-white">{p.label}</div>
                    <ul className="mt-3 flex-1 space-y-1.5 text-sm text-mist-300">
                      <li>{limit(p.branches, 'branches')}</li>
                      <li>{limit(p.users, 'team members')}</li>
                      <li>Every dashboard, live queue and import</li>
                      {p.id === 'enterprise' && <li>Custom terms and onboarding</li>}
                    </ul>
                    {p.id === 'enterprise' ? (
                      <a className="btn-ghost mt-4" href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`FalconMed Enterprise — ${user.orgName}`)}`}>
                        <Mail className="h-4 w-4" /> Contact sales
                      </a>
                    ) : (
                      <button
                        className={cn('mt-4', p.id === 'pro' ? 'btn-primary' : 'btn-ghost')}
                        disabled={!p.purchasable || !user.emailVerified || Boolean(busy)}
                        onClick={() => go('/billing/checkout', { plan: p.id }, p.id)}
                      >
                        {busy === p.id ? <Spinner className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />} Choose {p.label}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {b.plan === 'trial' && b.entitled && (
                <p className="mt-4 text-xs text-mist-500">Subscribe with more than two days of trial left and you keep them: the first charge comes when the trial ends.</p>
              )}
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
