import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Activity, Building2, CreditCard, FileUp, FlaskConical, KeyRound, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Network, Settings2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { cn, ROLE_LABEL } from '../lib/format';
import { APP_VERSION } from '../lib/version';

const NAV = {
  pharmacist: [{ to: '/counter', label: 'My counter', icon: MonitorSmartphone }],
  manager: [
    { to: '/branch', label: 'Branch performance', icon: LayoutDashboard },
    { to: '/live', label: 'Live queue', icon: Activity },
    { to: '/import', label: 'Import data', icon: FileUp },
    { to: '/simulator', label: 'Queue simulator', icon: FlaskConical },
  ],
  admin: [
    { to: '/network', label: 'Network overview', icon: Network },
    { to: '/live', label: 'Live queue', icon: Activity },
    { to: '/import', label: 'Import data', icon: FileUp },
    { to: '/simulator', label: 'Queue simulator', icon: FlaskConical },
    { to: '/settings', label: 'Settings', icon: Settings2 },
    { to: '/billing', label: 'Billing', icon: CreditCard },
  ],
};

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand shadow-lg shadow-brand/30">
        <svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden>
          <path d="M8 22 L16 8 L24 22 M11.5 17 H20.5" stroke="#E8EEF8" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="font-display text-[15px] font-semibold text-white">FalconMed Elite</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-mist-400">Queue analytics · v{APP_VERSION}</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }) {
  const { user, logout } = useAuth();
  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('');

  return (
    <div className="flex h-full flex-col gap-6 p-5">
      <Brand />
      {user.orgName && (
        <div className="rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5" title="Your organisation — you only ever see its data">
          <div className="label">Organisation</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-white">{user.orgName}</div>
        </div>
      )}
      <nav className="flex flex-col gap-1" aria-label="Main">
        <div className="label mb-1 px-3">Workspace</div>
        {NAV[user.role].map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                isActive ? 'bg-brand/15 text-white ring-1 ring-inset ring-brand/40' : 'text-mist-300 hover:bg-ink-800 hover:text-white',
              )
            }
          >
            <Icon className="h-[18px] w-[18px] opacity-80 group-hover:opacity-100" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-3">
        <div className="rounded-xl border border-ink-700 bg-ink-900/70 p-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-ok font-display text-sm font-semibold text-white">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{user.name}</div>
              <div className="truncate text-xs text-mist-400">
                {ROLE_LABEL[user.role]}
                {user.counterNo ? ` · Counter ${user.counterNo}` : ''}
              </div>
            </div>
          </div>
          {user.branchName && (
            <div className="mt-2.5 flex items-center gap-1.5 border-t border-ink-700 pt-2.5 text-xs text-mist-300">
              <Building2 className="h-3.5 w-3.5 text-mist-400" aria-hidden /> {user.branchName}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NavLink to="/account" onClick={onNavigate} className={({ isActive }) => cn('btn-ghost px-3', isActive && 'border-brand/50 text-white')}>
            <KeyRound className="h-4 w-4" aria-hidden /> Account
          </NavLink>
          <button onClick={logout} className="btn-ghost px-3">
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

const bannerCls = (tone) =>
  cn(
    'border-b px-4 py-1.5 text-center text-[11px] sm:px-8',
    tone === 'crit' ? 'border-crit/25 bg-crit/10 text-crit-300' : tone === 'warn' ? 'border-warn/20 bg-warn/[0.07] text-warn-300' : 'border-brand/25 bg-brand/[0.08] text-brand-200',
  );

/** Demo organisations get the demo notice; trial organisations see the days left; billing problems are flagged. */
function PlanBanner({ user }) {
  const billing = user.role === 'admin' ? (
    <Link to="/billing" className="ml-2 font-semibold underline underline-offset-2">
      Billing
    </Link>
  ) : null;
  if (user.orgPlan === 'demo') {
    return (
      <div className={bannerCls('warn')}>
        <span className="font-mono uppercase tracking-[0.12em]">Demo environment</span>
        <span className="mx-2 text-warn/50">·</span>
        Simulated pharmacy network. All tickets are generated; no real patient data.
      </div>
    );
  }
  if (user.entitled === false) {
    return (
      <div className={bannerCls('crit')}>
        {user.entitlementReason === 'trial_ended' ? 'Your free trial has ended.' : 'Your subscription is not active.'} Your data is safe.
        {billing ?? ' Ask your organisation admin to choose a plan.'}
      </div>
    );
  }
  if (user.subscriptionStatus === 'past_due') {
    return <div className={bannerCls('warn')}>The latest payment failed. Stripe is retrying — please update the payment method.{billing}</div>;
  }
  if (user.orgPlan === 'trial' && user.trialEndsAt) {
    const days = Math.max(0, Math.ceil((new Date(user.trialEndsAt).getTime() - Date.now()) / 86_400_000));
    return (
      <div className={bannerCls(days <= 3 ? 'warn' : 'brand')}>
        <span className="font-mono uppercase tracking-[0.12em]">Free trial</span>
        <span className="mx-2 opacity-50">·</span>
        {days} day{days === 1 ? '' : 's'} left{billing && <> ·{billing}</>}
      </div>
    );
  }
  return null;
}

/** New accounts are asked to confirm their email address. */
function VerifyBanner({ user }) {
  const [state, setState] = useState('idle');
  if (user.emailVerified || user.demoProtected) return null;
  const resend = async () => {
    setState('sending');
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      setState('sent');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className={bannerCls('brand')}>
      Please confirm your email address — we sent a link to {user.email}.{' '}
      {state === 'sent' ? (
        <span className="font-semibold">Sent again.</span>
      ) : (
        <button onClick={resend} disabled={state === 'sending'} className="font-semibold underline underline-offset-2">
          {state === 'failed' ? 'Try again' : 'Send it again'}
        </button>
      )}
    </div>
  );
}

export default function AppShell({ children }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="min-h-screen lg:pl-[264px]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] border-r border-ink-700/70 bg-ink-900/80 backdrop-blur lg:block">
        <Sidebar />
      </aside>

      {/* mobile */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-ink-700/70 bg-ink-900/90 px-4 py-3 backdrop-blur lg:hidden">
        <Brand />
        <button className="btn-ghost px-2.5 py-2" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] border-r border-ink-700 bg-ink-900">
            <button className="absolute right-3 top-4 rounded-lg p-1.5 text-mist-300 hover:bg-ink-800" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <PlanBanner user={user} />
      <VerifyBanner user={user} />

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-8 sm:py-8">{children}</main>
    </div>
  );
}
