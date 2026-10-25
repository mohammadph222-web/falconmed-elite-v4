import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Plus, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { cn, fmtClock, SERVICE_LABEL } from '../lib/format';
import { LiveDot, PageHeader, Panel, Segmented } from '../components/ui';
import { LivePulse, WaitingList } from '../components/LiveBoard';
import { EmptyState, Spinner } from '../components/States';
import { BranchSelect } from './LiveQueuePage';

// Realistic service mix used when "Mixed" is selected.
const MIX = [
  ['prescription', 58],
  ['refill', 18],
  ['otc', 12],
  ['insurance', 7],
  ['consultation', 5],
];
const pickService = () => {
  let r = Math.random() * 100;
  for (const [k, w] of MIX) if ((r -= w) <= 0) return k;
  return 'prescription';
};
const randomRef = () => `MRN-${Math.floor(100000 + Math.random() * 900000)}`;

export default function SimulatorPage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [branchId, setBranchId] = useState(isAdmin ? 'br_ad01' : user.branchId);
  const [service, setService] = useState('mixed');
  const [unidentifiedPct, setUnidentifiedPct] = useState(3);
  const [rate, setRate] = useState(6); // patients per minute in auto mode
  const [auto, setAuto] = useState(false);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const live = useApi('/queue/live', { branchId }, { interval: 4000 });

  const register = useCallback(
    async (n = 1) => {
      setBusy(true);
      setError(null);
      try {
        for (let i = 0; i < n; i++) {
          const identified = Math.random() * 100 >= unidentifiedPct;
          const r = await api('/queue/tickets', {
            method: 'POST',
            body: {
              branchId,
              serviceType: service === 'mixed' ? pickService() : service,
              identified,
              patientRef: identified ? randomRef() : undefined,
            },
          });
          setLog((l) => [r.data, ...l].slice(0, 30));
        }
        live.reload();
      } catch (err) {
        setError(err.message);
        setAuto(false);
      } finally {
        setBusy(false);
      }
    },
    [branchId, service, unidentifiedPct, live],
  );

  // Auto mode: Poisson-like arrivals at the chosen rate.
  const registerRef = useRef(register);
  registerRef.current = register;
  useEffect(() => {
    if (!auto) return undefined;
    let timer;
    const schedule = () => {
      const meanMs = 60000 / rate;
      const delay = -Math.log(1 - Math.random()) * meanMs;
      timer = setTimeout(async () => {
        await registerRef.current(1);
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [auto, rate]);

  return (
    <>
      <PageHeader
        eyebrow="Testing tool"
        title="Queue machine simulator"
        subtitle="Registers patient arrivals exactly as the kiosk would. Open a pharmacist account in another window to serve them."
        actions={isAdmin && <BranchSelect value={branchId} onChange={(v) => v && setBranchId(v)} />}
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Arrival settings">
            <div className="space-y-5">
              <div>
                <div className="label mb-2">Service line</div>
                <select className="input" value={service} onChange={(e) => setService(e.target.value)}>
                  <option value="mixed">Mixed (realistic distribution)</option>
                  {Object.entries(SERVICE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <label className="block">
                <div className="mb-2 flex justify-between">
                  <span className="label">Unidentified patients</span>
                  <span className="font-mono text-xs text-mist-200">{unidentifiedPct}%</span>
                </div>
                <input type="range" min={0} max={30} value={unidentifiedPct} onChange={(e) => setUnidentifiedPct(Number(e.target.value))} className="w-full accent-brand-400" />
              </label>

              <div className="flex flex-wrap gap-2">
                <button className="btn-primary" disabled={busy || auto} onClick={() => register(1)}>
                  <Plus className="h-4 w-4" /> Register 1
                </button>
                <button className="btn-ghost" disabled={busy || auto} onClick={() => register(10)}>
                  <Zap className="h-4 w-4" /> Rush of 10
                </button>
              </div>

              <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="label">Auto arrivals</span>
                  {auto && <LiveDot label="Running" />}
                </div>
                <Segmented
                  size="sm"
                  value={String(rate)}
                  onChange={(v) => setRate(Number(v))}
                  options={[
                    { id: '2', label: '2/min' },
                    { id: '6', label: '6/min' },
                    { id: '12', label: '12/min' },
                  ]}
                />
                <button className={cn('mt-3 w-full', auto ? 'btn-warn' : 'btn-ok')} onClick={() => setAuto((a) => !a)}>
                  {auto ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  {auto ? 'Stop auto arrivals' : 'Start auto arrivals'}
                </button>
              </div>
              {error && <p className="text-sm text-crit-300">{error}</p>}
            </div>
          </Panel>

          <Panel title="Registered this session" bodyClassName="max-h-72 overflow-y-auto">
            {log.length ? (
              <ul className="divide-y divide-ink-800">
                {log.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2 text-sm animate-rise">
                    <span className="rounded-md bg-ink-700/70 px-2 py-0.5 font-mono text-white">{t.ticketNo}</span>
                    <span className="flex-1 text-mist-300">{SERVICE_LABEL[t.serviceType]}</span>
                    {!t.identified && <span className="text-[11px] text-warn-300">unidentified</span>}
                    <span className="font-mono text-xs text-mist-500">{fmtClock(t.arrivedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing registered yet" />
            )}
          </Panel>
        </div>

        <div className="space-y-4 xl:col-span-3">
          {live.data ? <LivePulse live={live.data} target={live.data.targetWaitMin} /> : <Spinner className="mx-auto my-8 h-6 w-6" />}
          <Panel title="Branch queue" right={<LiveDot />}>
            {live.data ? <WaitingList tickets={live.data.waiting} target={live.data.targetWaitMin} limit={20} /> : <Spinner className="mx-auto my-10 h-6 w-6" />}
          </Panel>
        </div>
      </div>
    </>
  );
}
