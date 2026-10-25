import { AlertOctagon, AlertTriangle, CheckCircle2, Clock, UserCheck, Users } from 'lucide-react';
import { cn, fmtClock, fmtMinutes, fmtPct, SERVICE_LABEL } from '../lib/format';
import { EmptyState } from './States';

export function AlertList({ alerts }) {
  if (!alerts?.length) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-ok/25 bg-ok/[0.07] px-3.5 py-3 text-sm text-ok-300">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> Queue is flowing within target.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {alerts.map((a) => {
        const crit = a.severity === 'critical';
        const Icon = crit ? AlertOctagon : AlertTriangle;
        return (
          <li
            key={a.id}
            className={cn(
              'flex items-start gap-2.5 rounded-xl border px-3.5 py-3',
              crit ? 'border-crit/35 bg-crit/[0.08]' : 'border-warn/30 bg-warn/[0.07]',
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', crit ? 'text-crit-300' : 'text-warn-300')} aria-hidden />
            <div>
              <div className={cn('text-sm font-semibold', crit ? 'text-crit-300' : 'text-warn-300')}>{a.title}</div>
              <div className="text-xs text-mist-300">{a.message}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Stat({ icon: Icon, label, value, tone }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-mist-400">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <span className="label">{label}</span>
      </div>
      <div className={cn('mt-1 font-display text-xl font-semibold tabular', tone ?? 'text-white')}>{value}</div>
    </div>
  );
}

export function LivePulse({ live, target }) {
  const oldestTone = live.oldestWaitMin > target * 2 ? 'text-crit-300' : live.oldestWaitMin > target ? 'text-warn-300' : 'text-white';
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Stat icon={Users} label="Waiting" value={live.counts.waiting} />
      <Stat icon={UserCheck} label="At counters" value={`${live.counts.inService}/${live.counts.counters}`} />
      <Stat icon={Clock} label="Longest wait" value={fmtMinutes(live.oldestWaitMin)} tone={oldestTone} />
      <Stat icon={CheckCircle2} label="Last 60 min" value={`${live.lastHour.served} served`} />
    </div>
  );
}

function waitTone(min, target) {
  if (min > target * 2) return 'text-crit-300';
  if (min > target) return 'text-warn-300';
  return 'text-mist-200';
}

export function WaitingList({ tickets, target, showBranch, limit = 12 }) {
  if (!tickets?.length) return <EmptyState title="Nobody is waiting" />;
  const shown = tickets.slice(0, limit);
  return (
    <div>
      <ol className="divide-y divide-ink-800">
        {shown.map((t, i) => (
          <li key={t.id} className="flex items-center gap-3 py-2.5">
            <span className="w-5 font-mono text-xs text-mist-500">{i + 1}</span>
            <span className="rounded-md bg-ink-700/70 px-2 py-0.5 font-mono text-sm font-medium text-white">{t.ticketNo}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-mist-200">{SERVICE_LABEL[t.serviceType]}</div>
              <div className="text-[11px] text-mist-500">
                Arrived {fmtClock(t.arrivedAt)}
                {showBranch && ` · ${t.branchId}`}
                {!t.identified && ' · unidentified'}
              </div>
            </div>
            <span className={cn('font-mono text-sm tabular', waitTone(t.waitingMin, target))}>{fmtMinutes(t.waitingMin)}</span>
          </li>
        ))}
      </ol>
      {tickets.length > limit && <p className="pt-2 text-center text-xs text-mist-500">+{tickets.length - limit} more waiting</p>}
    </div>
  );
}

export function CounterList({ tickets }) {
  if (!tickets?.length) return <EmptyState title="No counter is serving right now" />;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {[...tickets]
        .sort((a, b) => (a.counterNo ?? 0) - (b.counterNo ?? 0))
        .map((t) => (
          <li key={t.id} className="flex items-center gap-3 rounded-xl border border-brand/25 bg-brand/[0.07] px-3 py-2.5">
            <div className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg bg-brand/20 leading-none">
              <span className="font-mono text-[9px] text-brand-300">CTR</span>
              <span className="font-display text-sm font-semibold text-white">{t.counterNo}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-white">{t.pharmacistName}</div>
              <div className="text-[11px] text-mist-400">
                <span className="font-mono text-mist-200">{t.ticketNo}</span> · {SERVICE_LABEL[t.serviceType]}
              </div>
            </div>
            <span className="font-mono text-xs text-mist-300 tabular">{fmtMinutes(t.serviceMin)}</span>
          </li>
        ))}
    </ul>
  );
}

export function LastHourLine({ live }) {
  return (
    <div className="text-xs text-mist-400">
      Last 60 min: <span className="text-mist-200">{live.lastHour.served}</span> served ·{' '}
      <span className="text-mist-200">{live.lastHour.noShow}</span> no-show · avg wait{' '}
      <span className="text-mist-200">{fmtMinutes(live.lastHour.avgWaitMin)}</span> ·{' '}
      <span className="text-mist-200">{fmtPct(live.lastHour.withinTargetRate)}</span> within target
    </div>
  );
}
