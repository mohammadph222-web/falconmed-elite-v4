import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmt1, fmtDay, fmtInt, fmtMinutes, fmtPct, SERVICE_LABEL, SOURCE_LABEL } from '../lib/format';
import { EmptyState } from './States';

export const C = {
  brand: '#4C8BD6',
  brandSoft: '#2563A8',
  ok: '#5CCBA2',
  warn: '#EBB461',
  crit: '#EE7A7A',
  grid: '#1A2942',
  axis: '#3A4F75',
  mist: '#9DADC8',
};

function ChartTooltip({ active, payload, label, rows }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl border border-ink-600 bg-ink-900/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur">
      <div className="mb-1.5 font-mono text-[11px] text-mist-400">{label}</div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-mist-300">
              <span className="h-2 w-2 rounded-full" style={{ background: r.color }} />
              {r.label}
            </span>
            <span className="font-medium text-white tabular">{r.value(p)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const axisProps = { stroke: C.axis, tickLine: false, axisLine: false };

/** Arrivals by hour (bars) with average wait (line) against the target. */
export function HourlyChart({ data, days = 1, target, height = 280 }) {
  const rows = (data ?? []).filter((d) => d.hour >= 7 && d.hour <= 23);
  if (!rows.some((r) => r.tickets > 0)) return <EmptyState />;
  const perDay = days > 1;
  const key = perDay ? 'avgPerDay' : 'tickets';
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 4, left: -6, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="label" {...axisProps} interval={1} />
        <YAxis yAxisId="n" {...axisProps} width={52} tickFormatter={(v) => fmtInt(v)} />
        <YAxis yAxisId="w" orientation="right" {...axisProps} width={36} tickFormatter={(v) => `${Number(v.toFixed(1))}m`} />
        <Tooltip
          cursor={{ fill: 'rgba(76,139,214,0.08)' }}
          content={
            <ChartTooltip
              rows={[
                { label: perDay ? 'Arrivals / day' : 'Arrivals', color: C.brandSoft, value: (p) => fmt1(p[key]) },
                { label: 'Avg wait', color: C.warn, value: (p) => fmtMinutes(p.avgWaitMin) },
                { label: 'Avg service', color: C.ok, value: (p) => fmtMinutes(p.avgServiceMin) },
              ]}
            />
          }
        />
        {target && <ReferenceLine yAxisId="w" y={target} stroke={C.crit} strokeDasharray="4 4" strokeOpacity={0.6} />}
        <Bar isAnimationActive={false} yAxisId="n" dataKey={key} fill={C.brandSoft} radius={[5, 5, 0, 0]} maxBarSize={28} />
        <Line isAnimationActive={false} yAxisId="w" dataKey="avgWaitMin" stroke={C.warn} strokeWidth={2} dot={false} connectNulls type="monotone" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Daily volume (bars) and share seen within the wait target (line). */
export function DailyChart({ data, height = 280 }) {
  if (!data?.some((d) => d.tickets > 0)) return <EmptyState />;
  const rows = data.map((d) => ({ ...d, day: fmtDay(d.date) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 4, left: -6, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="day" {...axisProps} minTickGap={18} />
        <YAxis yAxisId="n" {...axisProps} width={52} tickFormatter={(v) => fmtInt(v)} />
        <YAxis yAxisId="p" orientation="right" domain={[0, 100]} {...axisProps} width={38} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          cursor={{ fill: 'rgba(76,139,214,0.08)' }}
          content={
            <ChartTooltip
              rows={[
                { label: 'Tickets', color: C.brandSoft, value: (p) => fmtInt(p.tickets) },
                { label: 'Within wait target', color: C.ok, value: (p) => fmtPct(p.withinTargetRate) },
                { label: 'Avg wait', color: C.warn, value: (p) => fmtMinutes(p.avgWaitMin) },
                { label: 'No-shows', color: C.crit, value: (p) => fmtInt(p.noShow) },
              ]}
            />
          }
        />
        <ReferenceLine yAxisId="p" y={90} stroke={C.ok} strokeDasharray="4 4" strokeOpacity={0.45} />
        <Bar isAnimationActive={false} yAxisId="n" dataKey="tickets" fill={C.brandSoft} radius={[4, 4, 0, 0]} maxBarSize={22} />
        <Line isAnimationActive={false} yAxisId="p" dataKey="withinTargetRate" stroke={C.ok} strokeWidth={2} dot={false} connectNulls type="monotone" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

const STATUS_COLOR = { on_target: C.ok, watch: C.warn, action: C.crit, no_data: C.axis };

/** Branches ranked by share of patients called within the wait target. */
export function BranchChart({ data, height = 260 }) {
  const rows = (data ?? []).filter((b) => b.tickets > 0).sort((a, b) => (b.withinTargetRate ?? 0) - (a.withinTargetRate ?? 0));
  if (!rows.length) return <EmptyState />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={C.grid} horizontal={false} />
        <XAxis type="number" domain={[0, 100]} {...axisProps} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="name" {...axisProps} width={110} tick={{ fill: C.mist, fontSize: 12 }} />
        <Tooltip
          cursor={{ fill: 'rgba(76,139,214,0.08)' }}
          content={
            <ChartTooltip
              rows={[
                { label: 'Within target', color: C.ok, value: (p) => fmtPct(p.withinTargetRate) },
                { label: 'Avg wait', color: C.warn, value: (p) => fmtMinutes(p.avgWaitMin) },
                { label: 'Tickets / day', color: C.brandSoft, value: (p) => fmt1(p.ticketsPerDay) },
              ]}
            />
          }
        />
        <ReferenceLine x={90} stroke={C.ok} strokeDasharray="4 4" strokeOpacity={0.5} />
        <ReferenceLine x={75} stroke={C.warn} strokeDasharray="4 4" strokeOpacity={0.4} />
        <Bar isAnimationActive={false} dataKey="withinTargetRate" radius={[0, 6, 6, 0]} maxBarSize={22}>
          {rows.map((r) => (
            <Cell key={r.id} fill={STATUS_COLOR[r.status]} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Share bars for service mix / registration channel (no chart lib needed). */
export function ShareBars({ items, kind = 'service' }) {
  if (!items?.length) return <EmptyState />;
  const labels = kind === 'service' ? SERVICE_LABEL : SOURCE_LABEL;
  const colors = [C.brand, C.ok, C.warn, '#B28CF0', C.crit];
  return (
    <ul className="space-y-3">
      {items.map((it, i) => (
        <li key={it.key}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-mist-200">{labels[it.key] ?? it.key}</span>
            <span className="tabular text-mist-400">
              {fmtInt(it.tickets)} · <span className="text-white">{fmtPct(it.sharePct)}</span>
              {kind === 'service' && it.avgServiceMin !== null && <span className="ml-2 text-mist-500">{fmtMinutes(it.avgServiceMin)} avg</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-700/70">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${it.sharePct ?? 0}%`, background: colors[i % colors.length] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
