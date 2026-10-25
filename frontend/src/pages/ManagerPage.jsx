import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { compareLabel, presetRange } from '../lib/dates';
import { fmtRange } from '../lib/format';
import { LiveDot, PageHeader, Panel, Segmented } from '../components/ui';
import DateRange from '../components/DateRange';
import KpiRow from '../components/KpiRow';
import StaffTable from '../components/StaffTable';
import { DailyChart, HourlyChart, ShareBars } from '../components/charts';
import { AlertList, CounterList, LastHourLine, LivePulse } from '../components/LiveBoard';
import { Spinner } from '../components/States';

export default function ManagerPage() {
  const { user } = useAuth();
  const [range, setRange] = useState({ preset: '7d', ...presetRange('7d') });
  const [mixKind, setMixKind] = useState('service');
  const params = { from: range.from, to: range.to };

  const summary = useApi('/metrics/summary', params, { interval: 60000 });
  const hourly = useApi('/metrics/hourly', params);
  const daily = useApi('/metrics/daily', params, { enabled: range.from !== range.to });
  const staff = useApi('/metrics/staff', params, { interval: 60000 });
  const mix = useApi('/metrics/mix', params);
  const live = useApi('/queue/live', null, { interval: 10000 });

  const refresh = () => [summary, hourly, daily, staff, mix, live].forEach((q) => q.reload());
  const singleDay = range.from === range.to;
  const peak = summary.data?.peakHour;

  return (
    <>
      <PageHeader
        eyebrow={`Branch · ${user.branchName}`}
        title="Branch performance"
        subtitle={`${fmtRange(range.from, range.to)}${peak ? ` · busiest hour ${String(peak.hour).padStart(2, '0')}:00` : ''}`}
        actions={<DateRange value={range} onChange={setRange} onRefresh={refresh} refreshing={summary.loading} />}
      />

      <KpiRow summary={summary.data} compare={compareLabel(range.preset, summary.data)} />

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Right now"
          right={
            <div className="flex items-center gap-3">
              <LiveDot />
              <Link to="/live" className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-400">
                Full board <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          }
          error={live.error && !live.data ? live.error : null}
          onRetry={live.reload}
        >
          {live.data ? (
            <div className="space-y-4">
              <LivePulse live={live.data} target={live.data.targetWaitMin} />
              <CounterList tickets={live.data.inService} />
              <LastHourLine live={live.data} />
            </div>
          ) : (
            <Spinner className="mx-auto my-10 h-6 w-6" />
          )}
        </Panel>
        <Panel title="Alerts" subtitle="Derived from the live queue">
          {live.data ? <AlertList alerts={live.data.alerts} /> : <Spinner className="mx-auto my-10 h-6 w-6" />}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel
          title="Arrivals and wait by hour"
          subtitle={singleDay ? 'Bars: arrivals · line: average wait · dashed: target' : 'Bars: arrivals per day · line: average wait · dashed: target'}
          error={hourly.error}
          onRetry={hourly.reload}
        >
          {hourly.data ? (
            <HourlyChart data={hourly.data} days={summary.data?.range.days ?? 1} target={summary.data?.targetWaitMin} />
          ) : (
            <Spinner className="mx-auto my-16 h-6 w-6" />
          )}
        </Panel>
        {singleDay ? (
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
            {mix.data ? (
              <ShareBars items={mixKind === 'service' ? mix.data.byService : mix.data.bySource} kind={mixKind} />
            ) : (
              <Spinner className="mx-auto my-16 h-6 w-6" />
            )}
          </Panel>
        ) : (
          <Panel title="Daily trend" subtitle="Bars: tickets · line: % called within target · dashed: 90% goal" error={daily.error} onRetry={daily.reload}>
            {daily.data ? <DailyChart data={daily.data} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
          </Panel>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Panel className={singleDay ? 'xl:col-span-3' : 'xl:col-span-2'} title="Pharmacist performance" subtitle="From each pharmacist's own tickets in this period" error={staff.error} onRetry={staff.reload}>
          {staff.data ? <StaffTable rows={staff.data} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
        </Panel>
        {!singleDay && (
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
            {mix.data ? (
              <ShareBars items={mixKind === 'service' ? mix.data.byService : mix.data.bySource} kind={mixKind} />
            ) : (
              <Spinner className="mx-auto my-16 h-6 w-6" />
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
