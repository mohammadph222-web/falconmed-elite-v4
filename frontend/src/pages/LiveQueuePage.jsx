import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { fmtClock } from '../lib/format';
import { LiveDot, PageHeader, Panel } from '../components/ui';
import { AlertList, CounterList, LastHourLine, LivePulse, WaitingList } from '../components/LiveBoard';
import { ErrorState, Spinner } from '../components/States';

export function BranchSelect({ value, onChange, allowAll }) {
  const branches = useApi('/branches');
  return (
    <select
      className="input w-auto min-w-[200px] py-2"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Branch"
    >
      {allowAll && <option value="">All branches</option>}
      {(branches.data ?? []).map((b) => (
        <option key={b.id} value={b.id}>
          {b.name} · {b.city}
        </option>
      ))}
    </select>
  );
}

export default function LiveQueuePage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [branchId, setBranchId] = useState(isAdmin ? null : user.branchId);
  const live = useApi('/queue/live', { branchId: branchId ?? undefined }, { interval: 5000 });
  const d = live.data;

  return (
    <>
      <PageHeader
        eyebrow={isAdmin ? 'Network · live' : `${user.branchName} · live`}
        title="Live queue"
        subtitle={d ? `Updated ${fmtClock(d.asOf)} · refreshes every 5 seconds` : 'Connecting…'}
        actions={
          <>
            <LiveDot />
            {isAdmin && <BranchSelect value={branchId} onChange={setBranchId} allowAll />}
          </>
        }
      />

      {!d && live.error ? (
        <div className="panel">
          <ErrorState error={live.error} onRetry={live.reload} />
        </div>
      ) : !d ? (
        <Spinner className="mx-auto my-24 h-7 w-7" />
      ) : (
        <div className="space-y-4">
          <LivePulse live={d} target={d.targetWaitMin} />
          <div className="grid gap-4 xl:grid-cols-5">
            <Panel className="xl:col-span-3" title="Waiting" subtitle={`Longest first in line · amber > ${d.targetWaitMin} min · red > ${d.targetWaitMin * 2} min`}>
              <WaitingList tickets={d.waiting} target={d.targetWaitMin} showBranch={!branchId} limit={40} />
            </Panel>
            <div className="space-y-4 xl:col-span-2">
              <Panel title="Alerts">
                <AlertList alerts={d.alerts} />
              </Panel>
              <Panel title="At the counters" subtitle={<LastHourLine live={d} />}>
                <CounterList tickets={d.inService} />
              </Panel>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
