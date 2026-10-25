import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cn, isNum } from '../lib/format';
import { ErrorState, Skeleton } from './States';

export function PageHeader({ eyebrow, title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="animate-rise">
        {eyebrow && <div className="label mb-1.5">{eyebrow}</div>}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-[28px]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-mist-300">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, subtitle, right, children, className, bodyClassName, loading, error, onRetry }) {
  return (
    <section className={cn('panel flex min-w-0 flex-col animate-rise', className)}>
      {(title || right) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700/60 px-5 py-4">
          <div>
            {title && <h2 className="font-display text-[15px] font-semibold text-white">{title}</h2>}
            {subtitle && <div className="mt-0.5 text-xs text-mist-400">{subtitle}</div>}
          </div>
          {right}
        </header>
      )}
      <div className={cn('flex-1 p-5', bodyClassName)}>
        {error && !loading ? <ErrorState error={error} onRetry={onRetry} compact /> : children}
      </div>
    </section>
  );
}

/**
 * Change indicator. `goodWhen` says which direction is an improvement
 * ('up' for serve rate, 'down' for waiting time); colour follows that,
 * not the arrow.
 */
export function Delta({ value, unit = '%', goodWhen = 'up', label }) {
  if (!isNum(value)) return <span className="text-xs text-mist-500">{label ? `— ${label}` : '—'}</span>;
  const flat = Math.abs(value) < 0.05;
  const up = value > 0;
  const good = flat ? null : goodWhen === 'neutral' ? null : (up && goodWhen === 'up') || (!up && goodWhen === 'down');
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const text = unit === 'min' ? `${up ? '+' : ''}${value.toFixed(2)} min` : unit === 'pt' ? `${up ? '+' : ''}${value.toFixed(1)} pt` : `${up ? '+' : ''}${value.toFixed(1)}%`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium tabular',
        good === null ? 'text-mist-400' : good ? 'text-ok-300' : 'text-crit-300',
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {flat ? 'no change' : text}
      {label && <span className="ml-1 font-normal text-mist-500">{label}</span>}
    </span>
  );
}

const TONES = {
  brand: 'from-brand/25 text-brand-300',
  ok: 'from-ok/25 text-ok-300',
  warn: 'from-warn/25 text-warn-300',
  crit: 'from-crit/25 text-crit-300',
  mist: 'from-ink-600/40 text-mist-300',
};

export function KpiCard({ icon: Icon, label, value, sub, delta, tone = 'brand', loading, footnote }) {
  return (
    <div className="panel relative overflow-hidden p-4 animate-rise">
      <div className={cn('pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br to-transparent blur-xl', TONES[tone])} />
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {Icon && (
          <span className={cn('rounded-lg bg-gradient-to-br to-transparent p-1.5', TONES[tone])}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="mt-3 h-8 w-24" />
      ) : (
        <div className="mt-2 font-display text-[28px] font-semibold leading-none text-white tabular">{value}</div>
      )}
      <div className="mt-2 flex min-h-[18px] flex-wrap items-center gap-x-2 gap-y-1">
        {!loading && delta}
        {!loading && sub && <span className="text-xs text-mist-400">{sub}</span>}
      </div>
      {footnote && <div className="mt-1 text-[11px] text-mist-500">{footnote}</div>}
    </div>
  );
}

const STATUS = {
  on_target: ['On target', 'bg-ok/15 text-ok-300 ring-ok/30'],
  watch: ['Watch', 'bg-warn/15 text-warn-300 ring-warn/30'],
  action: ['Action needed', 'bg-crit/15 text-crit-300 ring-crit/30'],
  no_data: ['No data', 'bg-ink-700 text-mist-400 ring-ink-600'],
  waiting: ['Waiting', 'bg-warn/15 text-warn-300 ring-warn/30'],
  in_service: ['In service', 'bg-brand/20 text-brand-300 ring-brand/30'],
  served: ['Served', 'bg-ok/15 text-ok-300 ring-ok/30'],
  no_show: ['No-show', 'bg-crit/15 text-crit-300 ring-crit/30'],
};

export function StatusPill({ status }) {
  const [label, cls] = STATUS[status] ?? [status, 'bg-ink-700 text-mist-300 ring-ink-600'];
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', cls)}>{label}</span>;
}

export function Segmented({ options, value, onChange, size = 'md' }) {
  return (
    <div className="inline-flex rounded-xl border border-ink-600 bg-ink-900/80 p-1" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-lg font-medium transition',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === o.id ? 'bg-brand text-white shadow' : 'text-mist-300 hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LiveDot({ label = 'Live' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ok-300">
      <span className="h-2 w-2 rounded-full bg-ok-300 animate-pulse-dot" />
      {label}
    </span>
  );
}
