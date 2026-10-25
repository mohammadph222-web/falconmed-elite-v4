import { CheckCircle2, Clock, Hourglass, IdCard, Target, Ticket } from 'lucide-react';
import { fmtInt, fmtMinutes, fmtPct } from '../lib/format';
import { Delta, KpiCard } from './ui';

/** The six headline KPIs, each compared with the previous period of equal length. */
export default function KpiRow({ summary, compare }) {
  const k = summary?.current;
  const ch = summary?.change;
  const loading = !k;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <KpiCard
        icon={Ticket}
        label="Tickets"
        loading={loading}
        value={fmtInt(k?.totalTickets)}
        delta={<Delta value={ch?.totalTickets} goodWhen="neutral" />}
        footnote={loading ? null : compare}
      />
      <KpiCard
        icon={CheckCircle2}
        tone="ok"
        label="Serve rate"
        loading={loading}
        value={fmtPct(k?.serveRate)}
        sub={k ? `${fmtInt(k.noShow)} no-shows${k.abandoned ? ` · ${fmtInt(k.abandoned)} left unseen` : ''}` : null}
        delta={<Delta value={ch?.serveRate} unit="pt" />}
      />
      <KpiCard
        icon={Clock}
        tone="warn"
        label="Avg wait"
        loading={loading}
        value={fmtMinutes(k?.avgWaitMin)}
        sub={k ? `P90 ${fmtMinutes(k.p90WaitMin)}` : null}
        delta={<Delta value={ch?.avgWaitMin} unit="min" goodWhen="down" />}
      />
      <KpiCard
        icon={Target}
        tone="brand"
        label="Within target"
        loading={loading}
        value={fmtPct(k?.withinTargetRate)}
        sub={summary ? `wait ≤ ${summary.targetWaitMin} min` : null}
        delta={<Delta value={ch?.withinTargetRate} unit="pt" />}
      />
      <KpiCard
        icon={Hourglass}
        tone="mist"
        label="Avg service"
        loading={loading}
        value={fmtMinutes(k?.avgServiceMin)}
        sub={k ? `${fmtMinutes(k.avgTurnaroundMin)} door-to-done` : null}
      />
      <KpiCard
        icon={IdCard}
        tone="mist"
        label="Identified"
        loading={loading}
        value={fmtPct(k?.identifiedRate)}
        sub={k ? `${fmtInt(k.unidentified)} unidentified` : null}
        delta={<Delta value={ch?.identifiedRate} unit="pt" />}
      />
    </div>
  );
}
