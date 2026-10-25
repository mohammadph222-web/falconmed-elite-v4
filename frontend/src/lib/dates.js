import { BUSINESS_TZ } from './format';

const DAY = 86_400_000;

export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

export const shiftISO = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export const PRESETS = [
  { id: 'today', label: 'Today', range: () => ({ from: todayISO(), to: todayISO() }) },
  { id: 'yesterday', label: 'Yesterday', range: () => ({ from: shiftISO(todayISO(), -1), to: shiftISO(todayISO(), -1) }) },
  { id: '7d', label: '7 days', range: () => ({ from: shiftISO(todayISO(), -6), to: todayISO() }) },
  { id: '30d', label: '30 days', range: () => ({ from: shiftISO(todayISO(), -29), to: todayISO() }) },
];

export const presetRange = (id) => (PRESETS.find((p) => p.id === id) ?? PRESETS[0]).range();

export const COMPARE_LABEL = { today: 'vs yesterday', yesterday: 'vs day before', '7d': 'vs prior 7 days', '30d': 'vs prior 30 days' };

/**
 * Label for KPI deltas. When the period ends today, the server compares it with
 * the previous period cut at the same time of day, so the label says so.
 */
export function compareLabel(preset, summary) {
  const sameTime = summary?.comparison?.mode === 'same_time';
  if (!sameTime) return COMPARE_LABEL[preset] ?? 'vs prior period';
  if (preset === 'today') {
    const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TZ }).format(
      new Date(summary.comparison.asOf),
    );
    return `vs yesterday by ${at}`;
  }
  return `${COMPARE_LABEL[preset] ?? 'vs prior period'}, same time`;
}
