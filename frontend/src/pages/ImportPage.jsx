import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon, AlertTriangle, ArrowRight, CheckCircle2, Clock, Download, FileSpreadsheet, FlaskConical,
  Hourglass, RotateCcw, ShieldCheck, Target, Ticket, Upload,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { cn, fmtDay, fmtInt, fmtMinutes, fmtPct, fmtRange } from '../lib/format';
import { KpiCard, PageHeader, Panel } from '../components/ui';
import { EmptyState, Spinner } from '../components/States';

const MAX_BYTES = 8 * 1024 * 1024;

const SAMPLES = [
  { file: 'falconmed-import-template.csv', title: 'Template', desc: 'The recommended columns, with 3 example rows.' },
  { file: 'sample-clean-week.csv', title: 'Clean week', desc: '2,441 tickets from one realistic week. Scores 100 %.' },
  { file: 'sample-messy-export.csv', title: 'Messy export', desc: 'A raw queue-machine export with typical problems. See them caught.' },
];

const GRADE = {
  excellent: ['Excellent', 'text-ok-300', '#5CCBA2'],
  good: ['Good', 'text-ok-300', '#5CCBA2'],
  fair: ['Fair', 'text-warn-300', '#EBB461'],
  poor: ['Poor', 'text-crit-300', '#EE7A7A'],
  none: ['No usable rows', 'text-crit-300', '#EE7A7A'],
};

const FIELD_LABEL = {
  ticket_no: 'Ticket number', branch: 'Branch', date: 'Date', arrived_at: 'Arrival time', called_at: 'Call time',
  finished_at: 'Finish time', service_type: 'Service', outcome: 'Outcome', counter_no: 'Counter',
  pharmacist: 'Pharmacist', identified: 'Identified', patient_ref: 'Patient reference',
};

function ScoreRing({ score, grade }) {
  const [label, cls, color] = GRADE[grade] ?? GRADE.none;
  const r = 46;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, score ?? 0));
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 110 110" className="h-28 w-28 shrink-0 -rotate-90" aria-hidden>
        <circle cx="55" cy="55" r={r} fill="none" stroke="#1A2942" strokeWidth="10" />
        <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} style={{ transition: 'stroke-dashoffset .8s ease' }} />
      </svg>
      <div>
        <div className="label">Data quality</div>
        <div className="font-display text-4xl font-semibold text-white tabular">{fmtPct(score)}</div>
        <div className={cn('text-sm font-medium', cls)}>{label}</div>
        <div className="mt-1 text-xs text-mist-400">of rows can be imported</div>
      </div>
    </div>
  );
}

function IssueList({ issues }) {
  if (!issues.length) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-ok/25 bg-ok/[0.07] px-3.5 py-3 text-sm text-ok-300">
        <CheckCircle2 className="h-4 w-4" /> No problems found.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {issues.map((i) => {
        const isErr = i.severity === 'error';
        const Icon = isErr ? AlertOctagon : AlertTriangle;
        return (
          <li key={i.code} className={cn('rounded-xl border px-3.5 py-3', isErr ? 'border-crit/30 bg-crit/[0.06]' : 'border-warn/25 bg-warn/[0.05]')}>
            <div className="flex items-start gap-2.5">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', isErr ? 'text-crit-300' : 'text-warn-300')} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm font-medium text-mist-100">{i.message}</span>
                  <span className={cn('font-mono text-xs tabular', isErr ? 'text-crit-300' : 'text-warn-300')}>
                    {fmtInt(i.count)} {isErr ? 'rejected' : 'kept'}
                  </span>
                </div>
                <div className="mt-1 text-xs text-mist-400">
                  Row{i.rows.length > 1 ? 's' : ''} {i.rows.join(', ')}
                  {i.count > i.rows.length && ' …'}
                  {i.examples.length > 0 && (
                    <span className="ml-2 font-mono text-mist-500">e.g. {i.examples.slice(0, 2).join(' · ')}</span>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DayBars({ days }) {
  if (!days?.length) return null;
  const max = Math.max(...days.map((d) => d.tickets));
  return (
    <div className="flex h-24 items-end gap-1.5">
      {days.slice(-31).map((d) => (
        <div key={d.date} className="group flex flex-1 flex-col items-center gap-1" title={`${fmtDay(d.date)}: ${fmtInt(d.tickets)} tickets`}>
          <div className="w-full rounded-t bg-brand/70 group-hover:bg-brand-400" style={{ height: `${Math.max(4, (d.tickets / max) * 80)}px` }} />
          {days.length <= 10 && <span className="font-mono text-[10px] text-mist-500">{fmtDay(d.date)}</span>}
        </div>
      ))}
    </div>
  );
}

function Report({ report, onImport, onReset, importing }) {
  const s = report.summary;
  const f = report.file;
  const p = report.preview;
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  return (
    <div className="space-y-4">
      <section className="panel p-6 animate-rise">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <ScoreRing score={s.score} grade={s.grade} />
          <div className="grid flex-1 grid-cols-2 gap-2.5 sm:grid-cols-4 lg:max-w-2xl">
            {[
              ['Rows in file', fmtInt(s.total)],
              ['Usable', fmtInt(s.valid), 'text-ok-300'],
              ['Rejected', fmtInt(s.rejected), s.rejected ? 'text-crit-300' : undefined],
              ['Rows with warnings', fmtInt(s.rowsWithWarnings), s.rowsWithWarnings ? 'text-warn-300' : undefined],
            ].map(([k, v, cls]) => (
              <div key={k} className="rounded-xl border border-ink-700 bg-ink-900/60 px-3.5 py-3">
                <div className="label">{k}</div>
                <div className={cn('mt-1 font-display text-xl font-semibold tabular', cls ?? 'text-white')}>{v}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-3 border-t border-ink-700/60 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-mist-300">
            {s.valid > 0 ? (
              <>
                <span className="text-white">{fmtInt(s.valid)}</span> tickets from {s.dateFrom && fmtRange(s.dateFrom, s.dateTo)} into{' '}
                <span className="text-white">{s.branches.map((b) => b.name).join(', ')}</span>. Rejected rows are skipped; nothing is saved until you import.
              </>
            ) : (
              'No row passed the checks. Fix the file using the list below and try again.'
            )}
          </p>
          <div className="flex shrink-0 gap-2">
            <button className="btn-ghost" onClick={onReset} disabled={importing}>Choose another file</button>
            <button className="btn-primary" onClick={onImport} disabled={!report.canImport || importing}>
              {importing ? <Spinner className="h-4 w-4 text-white" /> : <Upload className="h-4 w-4" />}
              Import {fmtInt(s.valid)} rows
            </button>
          </div>
        </div>
      </section>

      {f.ignoredSensitive.length > 0 || s.emiratesIdValuesDropped > 0 ? (
        <div className="flex items-start gap-3 rounded-panel border border-brand/30 bg-brand/[0.08] px-4 py-3.5 animate-rise">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-300" aria-hidden />
          <div className="text-sm text-mist-200">
            <span className="font-semibold text-white">Patient privacy protected.</span>{' '}
            {f.ignoredSensitive.length > 0 && (
              <>Columns removed before reading: <span className="font-mono text-brand-300">{f.ignoredSensitive.join(', ')}</span>. </>
            )}
            {s.emiratesIdValuesDropped > 0 && <>{s.emiratesIdValuesDropped} value(s) that looked like an Emirates ID were not stored. </>}
            FalconMed never stores patient identifiers.
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-5">
        <Panel className="xl:col-span-3" title="What the check found" subtitle={`${errors.length} problem type(s) that reject rows · ${warnings.length} type(s) kept with a warning`}>
          <IssueList issues={report.issues} />
        </Panel>
        <Panel className="xl:col-span-2" title="How the file was read">
          <dl className="space-y-2 text-sm">
            {Object.entries(f.columns).map(([k, original]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-ink-800 pb-2 last:border-0">
                <dt className="truncate font-mono text-xs text-mist-300">{original}</dt>
                <dd className="text-xs text-mist-100">{FIELD_LABEL[k] ?? k}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 space-y-1.5 text-xs text-mist-400">
            <div>Date format: <span className="text-mist-200">{f.dateOrder}</span>{f.dateOrderEvidence > 0 && ` (confirmed by ${fmtInt(f.dateOrderEvidence)} values)`}</div>
            <div>Time precision: <span className="text-mist-200">{f.timePrecision}</span> · Time zone: <span className="text-mist-200">{f.timezone}</span></div>
            {f.unknownColumns.length > 0 && <div>Not used: <span className="font-mono text-mist-300">{f.unknownColumns.join(', ')}</span></div>}
            {s.noPharmacistLinked > 0 && <div>{fmtInt(s.noPharmacistLinked)} ticket(s) have no pharmacist link; they count in branch KPIs, not in the staff table.</div>}
          </div>
        </Panel>
      </div>

      {s.valid > 0 && (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="grid grid-cols-2 gap-3 xl:col-span-2 xl:grid-cols-3">
            <KpiCard icon={Ticket} label="Tickets" value={fmtInt(p.totalTickets)} sub={`${s.days} day(s)`} />
            <KpiCard icon={CheckCircle2} tone="ok" label="Serve rate" value={fmtPct(p.serveRate)} sub={`${fmtInt(p.noShow)} no-shows`} />
            <KpiCard icon={Clock} tone="warn" label="Avg wait" value={fmtMinutes(p.avgWaitMin)} />
            <KpiCard icon={Target} label="Within target" value={fmtPct(p.withinTargetRate)} />
            <KpiCard icon={Hourglass} tone="mist" label="Avg service" value={fmtMinutes(p.avgServiceMin)} />
            <KpiCard icon={FileSpreadsheet} tone="mist" label="Left unseen" value={fmtInt(p.abandoned)} sub={`${fmtInt(p.autoClosed)} never closed`} />
          </div>
          <Panel title="Tickets per day" subtitle="Preview, using the same KPI definitions as the dashboards">
            <DayBars days={report.byDay} />
          </Panel>
        </div>
      )}
    </div>
  );
}

function History({ onChanged, refreshKey }) {
  const hist = useApi('/imports', { k: refreshKey });
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);
  const rollback = async (id) => {
    if (confirm !== id) {
      setConfirm(id);
      setTimeout(() => setConfirm((c) => (c === id ? null : c)), 4000);
      return;
    }
    setBusy(id);
    try {
      await api(`/imports/${id}`, { method: 'DELETE' });
      onChanged?.();
      hist.reload();
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };
  return (
    <Panel title="Import history" subtitle="Each import can be rolled back; its tickets are removed from every dashboard." error={hist.error} onRetry={hist.reload}>
      {!hist.data ? (
        <Spinner className="mx-auto my-8 h-6 w-6" />
      ) : !hist.data.length ? (
        <EmptyState title="No imports yet" />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-ink-700/70 text-left">
                {['File', 'Dates', 'Imported', 'Rejected', 'Quality', 'By', ''].map((h, i) => (
                  <th key={h || i} className={cn('label whitespace-nowrap px-3 pb-3 font-normal', i === 0 && 'pl-5', i >= 2 && i <= 4 && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hist.data.map((b) => (
                <tr key={b.id} className="border-b border-ink-800 last:border-0">
                  <td className="py-3 pl-5 pr-3">
                    <div className="max-w-[240px] truncate font-medium text-white">{b.fileName}</div>
                    <div className="text-xs text-mist-500">#{b.id} · {new Date(b.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                  </td>
                  <td className="px-3 text-mist-300">{b.dateFrom ? fmtRange(b.dateFrom, b.dateTo) : '—'}</td>
                  <td className="px-3 text-right tabular text-white">{fmtInt(b.rowsImported)}</td>
                  <td className="px-3 text-right tabular text-mist-300">{fmtInt(b.rowsRejected)}</td>
                  <td className="px-3 text-right tabular text-mist-200">{fmtPct(b.qualityScore)}</td>
                  <td className="px-3 text-mist-300">{b.createdBy}</td>
                  <td className="pr-4 text-right">
                    <button
                      onClick={() => rollback(b.id)}
                      disabled={busy === b.id}
                      className={cn('btn px-2.5 py-1.5 text-xs', confirm === b.id ? 'bg-crit text-white hover:brightness-110' : 'btn-ghost')}
                    >
                      {busy === b.id ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      {confirm === b.id ? 'Click again to confirm' : 'Roll back'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function ImportPage() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const branches = useApi('/branches');
  const [branchId, setBranchId] = useState(isAdmin ? '' : user.branchId);
  // Admins start on their organisation's sandbox branch (or the first branch).
  useEffect(() => {
    const list = branches.data ?? [];
    if (!isAdmin || !list.length || list.some((b) => b.id === branchId)) return;
    setBranchId((list.find((b) => b.city === 'Sandbox') ?? list[0]).id);
  }, [isAdmin, branches.data, branchId]);
  const [file, setFile] = useState(null); // { name, text }
  const [report, setReport] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // 'reading' | 'checking' | 'importing'
  const [drag, setDrag] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const inputRef = useRef(null);

  const check = useCallback(
    async (name, text) => {
      setError(null);
      setResult(null);
      setReport(null);
      setFile({ name, text });
      setBusy('checking');
      try {
        const r = await api('/imports/validate', { method: 'POST', body: { csv: text, fileName: name, defaultBranchId: isAdmin ? branchId : undefined } });
        setReport(r.data);
      } catch (err) {
        setError(err.message);
        setFile(null);
      } finally {
        setBusy(null);
      }
    },
    [branchId, isAdmin],
  );

  const readFile = (f) => {
    if (!f) return;
    setError(null);
    if (f.size > MAX_BYTES) return setError('The file is larger than 8 MB. Split it by month and import each part.');
    if (!/\.(csv|txt|tsv)$/i.test(f.name)) return setError('Please choose a CSV file. In Excel use “Save As” and pick “CSV UTF-8”.');
    setBusy('reading');
    const reader = new FileReader();
    reader.onload = () => check(f.name, String(reader.result));
    reader.onerror = () => {
      setBusy(null);
      setError('The file could not be read.');
    };
    reader.readAsText(f);
  };

  const trySample = async (name) => {
    setBusy('reading');
    try {
      const res = await fetch(`/samples/${name}`);
      if (!res.ok) throw new Error();
      await check(name, await res.text());
    } catch {
      setBusy(null);
      setError('Could not load the sample file.');
    }
  };

  const doImport = async () => {
    setBusy('importing');
    setError(null);
    try {
      const r = await api('/imports', { method: 'POST', body: { csv: file.text, fileName: file.name, defaultBranchId: isAdmin ? branchId : undefined } });
      setResult(r.data);
      setReport(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setReport(null);
    setFile(null);
    setResult(null);
    setError(null);
  };

  const dashLink = (r) => {
    const s = r.report.summary;
    const q = new URLSearchParams({ from: s.dateFrom, to: s.dateTo });
    if (isAdmin && s.branches.length === 1) q.set('branchId', s.branches[0].id);
    return `${isAdmin ? '/network' : '/branch'}?${q}`;
  };

  return (
    <>
      <PageHeader
        eyebrow="Data quality"
        title="Import data"
        subtitle="Load an export from your own queue system. Every row is checked before anything is saved, and every import can be rolled back."
      />

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-panel border border-crit/35 bg-crit/10 px-4 py-3 text-sm text-crit-300">
          <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <section className="panel mb-4 flex flex-col gap-4 p-6 animate-rise sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-8 w-8 text-ok-300" />
            <div>
              <div className="font-display text-lg font-semibold text-white">Imported {fmtInt(result.report.summary.valid)} tickets</div>
              <div className="text-sm text-mist-400">
                Batch #{result.batchId} · {fmtRange(result.report.summary.dateFrom, result.report.summary.dateTo)} · quality {fmtPct(result.report.summary.score)}
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={reset}>Import another file</button>
            <Link className="btn-primary" to={dashLink(result)}>
              View in dashboard <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      )}

      {report ? (
        <Report report={report} onImport={doImport} onReset={reset} importing={busy === 'importing'} />
      ) : (
        !result && (
          <div className="grid gap-4 xl:grid-cols-5">
            <section className="panel xl:col-span-3 animate-rise">
              <div className="p-5">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    readFile(e.dataTransfer.files?.[0]);
                  }}
                  onClick={() => !busy && inputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
                  className={cn(
                    'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition',
                    drag ? 'border-brand-400 bg-brand/10' : 'border-ink-600 hover:border-ink-500 hover:bg-ink-800/40',
                  )}
                >
                  {busy ? (
                    <>
                      <Spinner className="mb-3 h-8 w-8" />
                      <div className="text-sm text-mist-200">{busy === 'reading' ? 'Reading file…' : `Checking ${file?.name ?? 'file'}…`}</div>
                    </>
                  ) : (
                    <>
                      <div className="mb-3 rounded-2xl bg-brand/15 p-3 text-brand-300">
                        <Upload className="h-7 w-7" />
                      </div>
                      <div className="font-display text-lg font-semibold text-white">Drop a CSV file here</div>
                      <div className="mt-1 text-sm text-mist-400">or click to choose · up to 50,000 rows / 8 MB</div>
                      <div className="mt-3 text-xs text-mist-500">From Excel: File, Save As, then choose “CSV UTF-8”.</div>
                    </>
                  )}
                  <input ref={inputRef} type="file" accept=".csv,.txt,.tsv,text/csv" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} />
                </div>

                <div className="mt-4 rounded-xl border border-ink-700 bg-ink-900/50 px-4 py-3 text-sm">
                  {isAdmin ? (
                    <label className="flex flex-wrap items-center gap-3">
                      <span className="text-mist-300">If the file has no branch column, import into</span>
                      <select className="input w-auto py-1.5" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                        {(branches.data ?? []).map((b) => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span className="text-mist-300">Rows will be imported into <span className="text-white">{user.branchName}</span>.</span>
                  )}
                </div>
              </div>
            </section>

            <Panel className="xl:col-span-2" title="Sample files" subtitle="Simulated data. Try one to see the quality check in action.">
              <ul className="space-y-3">
                {SAMPLES.map((s) => (
                  <li key={s.file} className="rounded-xl border border-ink-700 bg-ink-900/50 p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white">{s.title}</div>
                        <div className="mt-0.5 text-xs text-mist-400">{s.desc}</div>
                      </div>
                      <FileSpreadsheet className="h-5 w-5 shrink-0 text-mist-500" />
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button className="btn-primary px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => trySample(s.file)}>
                        <FlaskConical className="h-3.5 w-3.5" /> Check it
                      </button>
                      <a className="btn-ghost px-3 py-1.5 text-xs" href={`/samples/${s.file}`} download>
                        <Download className="h-3.5 w-3.5" /> Download
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
              {!isAdmin && (
                <p className="mt-3 text-xs text-mist-500">Samples belong to the Data Import Lab, so as a branch manager they will show as “outside your permission”. That is the check working.</p>
              )}
            </Panel>
          </div>
        )
      )}

      <div className="mt-4">
        <History refreshKey={refreshKey} />
      </div>
    </>
  );
}
