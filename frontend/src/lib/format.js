export const BUSINESS_TZ = 'Asia/Dubai';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const fmtInt = (v) => (isNum(v) ? nf0.format(v) : '—');
export const fmt1 = (v) => (isNum(v) ? nf1.format(v) : '—');
export const fmtPct = (v) => (isNum(v) ? `${nf1.format(v)}%` : '—');

/** 3.4 → "3m 24s", 0.6 → "36s" */
export function fmtMinutes(v) {
  if (!isNum(v)) return '—';
  const total = Math.round(v * 60);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return s ? `${m}m ${String(s).padStart(2, '0')}s` : `${m}m`;
}

export const fmtClock = (iso) =>
  iso ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TZ }).format(new Date(iso)) : '—';

export const fmtDay = (iso) =>
  iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : '';

export const fmtRange = (from, to) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);

export const SERVICE_LABEL = {
  prescription: 'Prescription',
  refill: 'Refill',
  consultation: 'Consultation',
  otc: 'OTC',
  insurance: 'Insurance approval',
};
export const SOURCE_LABEL = { mobile: 'Mobile booking', kiosk: 'Kiosk', walk_in: 'Walk-in', simulator: 'Simulator' };
export const ROLE_LABEL = { pharmacist: 'Pharmacist', manager: 'Branch manager', admin: 'Network admin' };

export const cn = (...parts) => parts.filter(Boolean).join(' ');
