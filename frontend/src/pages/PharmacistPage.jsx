import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Clock, Hourglass, Megaphone, Target, UserX, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { compareLabel, presetRange } from '../lib/dates';
import { cn, fmtClock, fmtInt, fmtMinutes, fmtPct, SERVICE_LABEL } from '../lib/format';
import { Delta, KpiCard, LiveDot, PageHeader, Panel, Segmented } from '../components/ui';
import { HourlyChart } from '../components/charts';
import { WaitingList } from '../components/LiveBoard';
import { Spinner } from '../components/States';

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function CounterConsole({ current, live, onAction, busy, message }) {
  const now = useNow(Boolean(current));
  const elapsed = current?.calledAt ? (now - new Date(current.calledAt).getTime()) / 60000 : 0;
  const waitedMin = current ? (new Date(current.calledAt) - new Date(current.arrivedAt)) / 60000 : 0;
  const target = live?.targetWaitMin ?? 5;

  return (
    <section className="panel relative overflow-hidden animate-rise">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand/15 blur-3xl" />
      <div className="relative grid gap-6 p-6 lg:grid-cols-[1.3fr_1fr] lg:p-8">
        <div>
          <div className="flex items-center justify-between">
            <span className="label">Now serving</span>
            <LiveDot />
          </div>

          {current ? (
            <div className="mt-4">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
                <div className="font-display text-6xl font-semibold leading-none tracking-tight text-white sm:text-7xl tabular">
                  {current.ticketNo}
                </div>
                <div className="pb-1">
                  <div className="text-base font-medium text-mist-100">{SERVICE_LABEL[current.serviceType]}</div>
                  <div className="text-xs text-mist-400">
                    Arrived {fmtClock(current.arrivedAt)} · waited{' '}
                    <span className={cn(waitedMin > target ? 'text-warn-300' : 'text-mist-200')}>{fmtMinutes(waitedMin)}</span>
                    {!current.identified && ' · unidentified patient'}
                  </div>
                </div>
              </div>
              <div className="mt-5 inline-flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-900/70 px-3 py-2">
                <Clock className="h-4 w-4 text-brand-300" aria-hidden />
                <span className="text-xs text-mist-400">At counter</span>
                <span className="font-mono text-lg text-white tabular">{fmtMinutes(elapsed)}</span>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="font-display text-3xl font-semibold text-mist-300">Counter is free</div>
              <p className="mt-1 text-sm text-mist-400">
                {live?.counts.waiting ? `${live.counts.waiting} patient${live.counts.waiting > 1 ? 's' : ''} waiting in your branch.` : 'No one is waiting right now.'}
              </p>
            </div>
          )}

          <div className="mt-7 flex flex-wrap gap-2.5">
            {current ? (
              <>
                <button className="btn-ok px-5 py-3 text-base" disabled={busy} onClick={() => onAction('served')}>
                  {busy === 'served' ? <Spinner className="h-4 w-4 text-white" /> : <CheckCircle2 className="h-5 w-5" />}
                  Served
                  <kbd className="ml-1 rounded bg-black/20 px-1.5 font-mono text-[10px]">S</kbd>
                </button>
                <button className="btn-warn px-5 py-3 text-base" disabled={busy} onClick={() => onAction('no_show')}>
                  {busy === 'no_show' ? <Spinner className="h-4 w-4" /> : <UserX className="h-5 w-5" />}
                  No-show
                  <kbd className="ml-1 rounded bg-black/20 px-1.5 font-mono text-[10px]">X</kbd>
                </button>
              </>
            ) : (
              <button className="btn-primary px-6 py-3 text-base" disabled={busy || !live?.counts.waiting} onClick={() => onAction('next')}>
                {busy === 'next' ? <Spinner className="h-4 w-4 text-white" /> : <Megaphone className="h-5 w-5" />}
                Call next patient
                <kbd className="ml-1 rounded bg-black/20 px-1.5 font-mono text-[10px]">N</kbd>
              </button>
            )}
          </div>
          {message && <p className={cn('mt-3 text-sm', message.tone === 'error' ? 'text-crit-300' : 'text-mist-300')}>{message.text}</p>}
        </div>

        <div className="rounded-xl border border-ink-700 bg-ink-900/50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="label">Up next in branch</span>
            <span className="inline-flex items-center gap-1 text-xs text-mist-400">
              <Users className="h-3.5 w-3.5" /> {live?.counts.waiting ?? '—'}
            </span>
          </div>
          {live ? <WaitingList tickets={live.waiting} target={target} limit={5} /> : <Spinner className="mx-auto my-6 h-5 w-5" />}
        </div>
      </div>
    </section>
  );
}

export default function PharmacistPage() {
  const { user } = useAuth();
  const [preset, setPreset] = useState('today');
  const range = presetRange(preset);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  const current = useApi('/queue/current', null, { interval: 5000 });
  const live = useApi('/queue/live', null, { interval: 5000 });
  const summary = useApi('/metrics/summary', range, { interval: 30000 });
  const hourly = useApi('/metrics/hourly', range, { interval: 60000 });

  const k = summary.data?.current;
  const ch = summary.data?.change;
  const compare = compareLabel(preset, summary.data);

  const act = useCallback(
    async (kind) => {
      if (busy) return;
      setBusy(kind);
      setMessage(null);
      try {
        if (kind === 'next') {
          const r = await api('/queue/call-next', { method: 'POST' });
          setMessage(r.data ? { text: `Called ${r.data.ticketNo} to counter ${user.counterNo}.` } : { text: 'No patients waiting.' });
        } else if (current.data) {
          const r = await api(`/queue/tickets/${current.data.id}/complete`, { method: 'POST', body: { outcome: kind } });
          setMessage({ text: `${r.data.ticketNo} closed as ${kind === 'served' ? 'served' : 'no-show'}.` });
        }
        await Promise.all([current.reload(), live.reload(), summary.reload()]);
      } catch (err) {
        setMessage({ tone: 'error', text: err.message });
        current.reload();
      } finally {
        setBusy(null);
      }
    },
    [busy, current, live, summary, user.counterNo],
  );

  // Keyboard shortcuts for counter work: N next · S served · X no-show.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'n' && !current.data) act('next');
      if (key === 's' && current.data) act('served');
      if (key === 'x' && current.data) act('no_show');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, current.data]);

  return (
    <>
      <PageHeader
        eyebrow={`${user.branchName} · Counter ${user.counterNo}`}
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${user.name.split(' ')[0]}`}
        subtitle="Call, serve and close patients. Your numbers update as you work."
      />

      <CounterConsole current={current.data} live={live.data} onAction={act} busy={busy} message={message} />

      <div className="mb-4 mt-8 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-white">My performance</h2>
          {summary.data && <p className="mt-0.5 text-xs text-mist-400">Changes shown {compare}</p>}
        </div>
        <Segmented
          size="sm"
          value={preset}
          onChange={setPreset}
          options={[
            { id: 'today', label: 'Today' },
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' },
          ]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          icon={CheckCircle2}
          tone="ok"
          label="Patients served"
          loading={!k}
          value={fmtInt(k?.served)}
          delta={<Delta value={ch?.served} />}
        />
        <KpiCard
          icon={Hourglass}
          label="Avg service time"
          loading={!k}
          value={fmtMinutes(k?.avgServiceMin)}
          delta={<Delta value={ch?.avgServiceMin} unit="min" goodWhen="neutral" />}
        />
        <KpiCard
          icon={Target}
          tone="brand"
          label="Called within target"
          loading={!k}
          value={fmtPct(k?.withinTargetRate)}
          sub={summary.data ? `wait ≤ ${summary.data.targetWaitMin} min` : null}
          delta={<Delta value={ch?.withinTargetRate} unit="pt" />}
        />
        <KpiCard
          icon={UserX}
          tone="warn"
          label="No-shows"
          loading={!k}
          value={fmtInt(k?.noShow)}
          sub={k ? `${fmtPct(k.noShowRate)} of closed` : null}
        />
      </div>

      <Panel
        className="mt-4"
        title="My patients by hour"
        subtitle={preset === 'today' ? 'Patients you called today, by arrival hour' : 'Average patients per day, by arrival hour'}
        loading={!hourly.data}
        error={hourly.error}
        onRetry={hourly.reload}
      >
        {hourly.data ? <HourlyChart data={hourly.data} days={summary.data?.range.days ?? 1} target={summary.data?.targetWaitMin} /> : <Spinner className="mx-auto my-16 h-6 w-6" />}
      </Panel>
    </>
  );
}
