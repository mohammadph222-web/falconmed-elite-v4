import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2, ChevronRight } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { compareLabel, presetRange } from '../lib/dates';
import { cn, fmt1, fmtMinutes, fmtPct, fmtRange } from '../lib/format';
import { PageHeader, Panel, Segmented, StatusPill } from '../components/ui';
import DateRange from '../components/DateRange';
import KpiRow from '../components/KpiRow';
import StaffTable from '../components/StaffTable';
import { BranchChart, DailyChart, HourlyChart, ShareBars } from '../components/charts';
import { EmptyState, Spinner } from '../components/States';

function BranchTable({ rows, selected, onSelect }) {
  if (!rows?.length) return <EmptyState />;
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[780px] text-sm">
        <thead>
          <tr className="border-b border-ink-700/70 text-left">
            {['Branch', 'Tickets / day', 'Serve rate', 'Avg wait', 'Within target', 'Avg service', 'Identified', 'Status', ''].map((h, i) => (
              <th key={h || i} className={cn('label whitespace-nowrap px-3 pb-3 font-normal', i === 0 ? 'pl-5' : 'text-right', i === 7 && 'text-left')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr
              key={b.id}
              onClick={() => onSelect(selected === b.id ? null : b.id)}
              className={cn('cursor-pointer border-b border-ink-800 last:border-0 transition hover:bg-ink-800/50', selected === b.id && 'bg-brand/10')}
            >
              <td className="whitespace-nowrap py-3 pl-5 pr-3">
                <div className="font-medium text-white">{b.name}</div>
                <div className="text-xs text-mist-400">
                  {b.city} · {b.counters} counters
                </div>
              </td>
              <td className="px-3 text-right tabular text-white">{fmt1(b.ticketsPerDay)}</td>
              <td className="px-3 text-right tabular text-mist-200">{fmtPct(b.serveRate)}</td>
              <td className="px-3 text-right tabular text-mist-200">{fmtMinutes(b.avgWaitMin)}</td>
              <td className="px-3 text-right tabular font-semibold text-white">{fmtPct(b.withinTargetRate)}</td>
              <td className="px-3 text-right tabular text-mist-200">{fmtMinutes(b.avgServiceMin)}</td>
              <td className="px-3 text-right tabular text-mist-200">{fmtPct(b.identifiedRate)}</td>
              <td className="px-3">
                <StatusPill status={b.status} />
              </td>
              <td className="pr-4 text-right">
                <ChevronRight className={cn('ml-auto h-4 w-4 text-mist-500 transition', selected === b.id && 'rotate-90 text-brand-300')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminPage() {
  const [searchParams] = useSearchParams();
  const linked = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('from') ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('to') ?? '');
  const [range, setRange] = useState(
    linked ? { preset: 'custom', from: searchParams.get('from'), to: searchParams.get('to') } : { preset: '30d', ...presetRange('30d') },
  );
  const [branchId, setBranchId] = useState(searchParams.get('branchId') || null);
  const [mixKind, setMixKind] = useState('service');

  const net = { from: range.from, to: range.to };
  const scoped = { ...net, branchId: branchId ?? undefined };

  const branches = useApi('/metrics/branches', net, { interval: 60000 });
  const summary = useApi('/metrics/summary', scoped, { interval: 60000 });
  const daily = useApi('/metrics/daily', scoped, { enabled: range.from !== range.to });
  const hourly = useApi('/metrics/hourly', scoped);
  const staff = useApi('/metrics/staff', scoped);
  const mix = useApi('/metrics/mix', scoped);

  const branchName = branches.data?.find((b) => b.id === branchId)?.name;
  const refresh = () => [branches, summary, daily, hourly, staff, mix].forEach((q) => q.reload());
  const singleDay = range.from === range.to;
  const counts = (branches.data ?? []).reduce((acc, b) => ({ ...acc, [b.status]: (acc[b.status] || 0) + 1 }), {});

  return (
    <>
      <PageHeader
        eyebrow="Network · all branches"
        title={branchName ? `${branchName}` : 'Network overview'}
        subtitle={
          branchName ? (
            <>
              Branch drill-down · {fmtRange(range.from, range.to)} ·{' '}
              <button className="text-brand-300 hover:underline" onClick={() => setBranchId(null)}>
                back to network
              </button>
            </>
          ) : (
            `${fmtRange(range.from, range.to)} · ${branches.data?.length ?? '—'} branches · ${counts.on_target ?? 0} on target, ${counts.watch ?? 0} watch, ${counts.action ?? 0} need action`
          )
        }
        actions={<DateRange value={range} onChange={setRange} onRefresh={refresh} refreshing={summary.loading} />}
      />

      <KpiRow summary={summary.data} compare={compareLabel(range.preset, summary.data)} />

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Panel
          className="xl:col-span-3"
          title="Branch scorecard"
          subtitle="Select a branch to drill down. Status: ≥90% within target on target · 75–90% watch · <75% action"
          error={branches.error}
          onRetry={branches.reload}
        >
          {branches.data ? <BranchTable rows={branches.data} selected={branchId} onSelect={setBranchId} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
        </Panel>
        <Panel className="xl:col-span-2" title="Patients called within target" subtitle="Share of called patients with wait ≤ target" error={branches.error}>
          {branches.data ? <BranchChart data={branches.data} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {!singleDay && (
          <Panel
            title={branchName ? `Daily trend · ${branchName}` : 'Daily trend · network'}
            subtitle="Bars: tickets · line: % within target · dashed: 90% goal"
            error={daily.error}
            onRetry={daily.reload}
          >
            {daily.data ? <DailyChart data={daily.data} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
          </Panel>
        )}
        <Panel
          className={singleDay ? 'xl:col-span-2' : undefined}
          title={branchName ? `Demand by hour · ${branchName}` : 'Demand by hour · network'}
          subtitle={singleDay ? 'Arrivals and average wait' : 'Average arrivals per day and average wait'}
          error={hourly.error}
          onRetry={hourly.reload}
        >
          {hourly.data ? (
            <HourlyChart data={hourly.data} days={summary.data?.range.days ?? 1} target={summary.data?.targetWaitMin} />
          ) : (
            <Spinner className="mx-auto my-16 h-6 w-6" />
          )}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title={branchName ? `Pharmacists · ${branchName}` : 'Top pharmacists · network'}
          subtitle="Ranked by patients served in this period"
          right={<Building2 className="h-4 w-4 text-mist-500" />}
          error={staff.error}
          onRetry={staff.reload}
        >
          {staff.data ? <StaffTable rows={staff.data} showBranch={!branchId} limit={branchId ? undefined : 10} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
        </Panel>
        <Panel
          title="Ticket mix"
          right={
            <Segmented
              size="sm"
              value={mixKind}
              onChange={setMixKind}
              options={[
                { id: 'service', label: 'Service' },
                { id: 'source', label: 'Channel' },
              ]}
            />
          }
          error={mix.error}
          onRetry={mix.reload}
        >
          {mix.data ? <ShareBars items={mixKind === 'service' ? mix.data.byService : mix.data.bySource} kind={mixKind} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
        </Panel>
      </div>
    </>
  );
}
