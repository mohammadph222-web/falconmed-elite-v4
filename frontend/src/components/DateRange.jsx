import { useState } from 'react';
import { CalendarRange, RefreshCw } from 'lucide-react';
import { PRESETS, presetRange, todayISO } from '../lib/dates';
import { cn, fmtRange } from '../lib/format';
import { Segmented } from './ui';

/** Presets plus a custom from/to picker. Calls onChange({ preset, from, to }). */
export default function DateRange({ value, onChange, onRefresh, refreshing }) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ from: value.from, to: value.to });
  const max = todayISO();

  const choose = (id) => {
    if (id === 'custom') {
      setDraft({ from: value.from, to: value.to });
      setCustom(true);
      return;
    }
    setCustom(false);
    onChange({ preset: id, ...presetRange(id) });
  };

  const apply = (e) => {
    e.preventDefault();
    if (draft.from && draft.to && draft.from <= draft.to) {
      onChange({ preset: 'custom', ...draft });
      setCustom(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        size="sm"
        value={custom ? 'custom' : value.preset}
        onChange={choose}
        options={[...PRESETS.map((p) => ({ id: p.id, label: p.label })), { id: 'custom', label: 'Custom' }]}
      />
      {custom ? (
        <form onSubmit={apply} className="flex items-center gap-2 rounded-xl border border-ink-600 bg-ink-900/80 p-1 pl-3">
          <CalendarRange className="h-4 w-4 text-mist-400" aria-hidden />
          <input
            type="date"
            aria-label="From"
            className="bg-transparent text-xs text-mist-100 [color-scheme:dark] focus:outline-none"
            max={draft.to || max}
            value={draft.from}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          />
          <span className="text-mist-500">→</span>
          <input
            type="date"
            aria-label="To"
            className="bg-transparent text-xs text-mist-100 [color-scheme:dark] focus:outline-none"
            min={draft.from}
            max={max}
            value={draft.to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          />
          <button className="btn-primary px-3 py-1 text-xs" disabled={!draft.from || !draft.to || draft.from > draft.to}>
            Apply
          </button>
        </form>
      ) : (
        <span className="hidden rounded-lg px-2 font-mono text-xs text-mist-400 sm:inline">{fmtRange(value.from, value.to)}</span>
      )}
      {onRefresh && (
        <button className="btn-ghost px-2.5 py-1.5" onClick={onRefresh} aria-label="Refresh data" title="Refresh">
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
        </button>
      )}
    </div>
  );
}
