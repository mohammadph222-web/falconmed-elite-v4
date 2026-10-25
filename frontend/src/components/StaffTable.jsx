import { useMemo, useState } from 'react';
import { ArrowDownUp } from 'lucide-react';
import { cn, fmt1, fmtInt, fmtMinutes, fmtPct } from '../lib/format';
import { EmptyState } from './States';

const COLUMNS = [
  { key: 'served', label: 'Served', fmt: fmtInt, desc: true },
  { key: 'servedPerDay', label: 'Per day', fmt: fmt1, desc: true },
  { key: 'avgServiceMin', label: 'Avg service', fmt: fmtMinutes, desc: false },
  { key: 'withinTargetRate', label: 'Within target', fmt: fmtPct, desc: true },
  { key: 'noShow', label: 'No-shows', fmt: fmtInt, desc: false },
  { key: 'sharePct', label: 'Share', fmt: fmtPct, desc: true },
];

/**
 * Pharmacist performance from their own tickets. "Within target" is the
 * share of the patients they called whose wait was within the target.
 */
export default function StaffTable({ rows, showBranch = false, limit }) {
  const [sort, setSort] = useState({ key: 'served', desc: true });
  const sorted = useMemo(() => {
    const list = [...(rows ?? [])].sort((a, b) => {
      const x = a[sort.key] ?? -Infinity;
      const y = b[sort.key] ?? -Infinity;
      return sort.desc ? y - x : x - y;
    });
    return limit ? list.slice(0, limit) : list;
  }, [rows, sort, limit]);

  if (!rows?.length) return <EmptyState title="No pharmacists in scope" />;
  const maxServed = Math.max(1, ...rows.map((r) => r.served));

  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-ink-700/70 text-left">
            <th className="label px-5 pb-3 font-normal">Pharmacist</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="label whitespace-nowrap px-3 pb-3 text-right font-normal">
                <button
                  className={cn('inline-flex items-center gap-1 hover:text-mist-100', sort.key === c.key && 'text-mist-100')}
                  onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.desc }))}
                >
                  {c.label}
                  <ArrowDownUp className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.id} className="border-b border-ink-800 last:border-0 hover:bg-ink-800/40">
              <td className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="w-5 font-mono text-xs text-mist-500">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-white">{r.name}</div>
                    <div className="text-xs text-mist-400">
                      Counter {r.counterNo}
                      {showBranch && ` · ${r.branchName}`}
                    </div>
                  </div>
                </div>
                <div className="ml-8 mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-ink-700/60">
                  <div className="h-full rounded-full bg-brand-400" style={{ width: `${(r.served / maxServed) * 100}%` }} />
                </div>
              </td>
              {COLUMNS.map((c) => (
                <td key={c.key} className={cn('px-3 py-3 text-right tabular', c.key === 'served' ? 'font-semibold text-white' : 'text-mist-200')}>
                  {c.fmt(r[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
