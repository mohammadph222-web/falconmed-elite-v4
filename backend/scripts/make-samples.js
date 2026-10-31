/**
 * Generates the importer's sample files into frontend/public/samples/.
 *   node scripts/make-samples.js
 *
 * 1. falconmed-import-template.csv  — the recommended format, 3 example rows
 * 2. sample-clean-week.csv          — one realistic week, clean (score ≈ 100 %)
 * 3. sample-messy-export.csv        — a raw queue-machine export with typical
 *    problems: other column names, semicolons, DD/MM dates, separate date and
 *    time columns, 12-hour times, patient-identifier columns, and ~8 % faulty rows.
 *
 * All data is simulated; names and phone numbers are obvious placeholders.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/public/samples');
mkdirSync(OUT, { recursive: true });

// deterministic random
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(31102026);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const lognormal = (mean, sigma = 0.45) => Math.exp(Math.log(mean) - (sigma * sigma) / 2 + sigma * gauss());
const pick = (w) => {
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (const [k, v] of Object.entries(w)) if ((r -= v) <= 0) return k;
  return Object.keys(w)[0];
};

const HOUR_WEIGHT = { 8: 2.5, 9: 4.5, 10: 6, 11: 6.5, 12: 6, 13: 6.5, 14: 8, 15: 10.5, 16: 9.5, 17: 8, 18: 7.5, 19: 7, 20: 6, 21: 4.5, 22: 2.5 };
const SERVICE = { prescription: { w: 58, mean: 3.4, p: 'A' }, refill: { w: 18, mean: 2.1, p: 'R' }, otc: { w: 12, mean: 1.4, p: 'O' }, insurance: { w: 7, mean: 5.2, p: 'I' }, consultation: { w: 5, mean: 6.5, p: 'C' } };
const STAFFING = (h) => (h < 10 || h >= 21 ? 0.5 : h >= 14 && h < 18 ? 1 : 0.75);

/** Simulate one day at a 4-counter pharmacy; times are minutes after midnight (local). */
function simulateDay(volume, counters = 4) {
  const totalW = Object.values(HOUR_WEIGHT).reduce((a, b) => a + b, 0);
  const arrivals = [];
  for (const [h, w] of Object.entries(HOUR_WEIGHT)) {
    const n = Math.max(0, Math.round((volume * w) / totalW + gauss() * 1.2));
    for (let i = 0; i < n; i++) arrivals.push(Number(h) * 60 + rand() * 59.5);
  }
  arrivals.sort((a, b) => a - b);
  const freeAt = Array(counters).fill(8 * 60);
  const seq = {};
  return arrivals.map((arr) => {
    const active = Math.max(1, Math.ceil(counters * STAFFING(Math.floor(arr / 60))));
    let k = 0;
    for (let i = 1; i < active; i++) if (freeAt[i] < freeAt[k]) k = i;
    const service = pick(Object.fromEntries(Object.entries(SERVICE).map(([s, v]) => [s, v.w])));
    const start = Math.max(arr, freeAt[k]) + 0.15 + rand() * 0.3;
    const noShow = rand() < 0.009;
    const dur = noShow ? 0.8 + rand() * 0.5 : Math.min(Math.max(lognormal(SERVICE[service].mean), 0.4), 25);
    freeAt[k] = start + dur;
    seq[service] = (seq[service] || 0) + 1;
    return {
      ticketNo: `${SERVICE[service].p}-${String(seq[service]).padStart(3, '0')}`,
      arrival: arr,
      called: start,
      finished: start + dur,
      service,
      noShow,
      counter: k + 1,
      identified: rand() < 0.975,
    };
  });
}

const pad = (n) => String(n).padStart(2, '0');
const hms = (m) => {
  const s = Math.round(m * 60);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const hm12 = (m) => {
  const total = Math.round(m);
  let h = Math.floor(total / 60);
  const mi = total % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad(h)}:${pad(mi)} ${ap}`;
};
const csvCell = (v, sep) => {
  const s = v === null || v === undefined ? '' : String(v);
  return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, sep = ',') => rows.map((r) => r.map((c) => csvCell(c, sep)).join(sep)).join('\n') + '\n';
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dmy = (iso) => iso.split('-').reverse().join('/');

// ── 1. template ──────────────────────────────────────────────────
const HEAD = ['ticket_no', 'branch', 'arrived_at', 'called_at', 'finished_at', 'service_type', 'outcome', 'counter_no', 'pharmacist', 'identified', 'patient_ref'];
writeFileSync(
  path.join(OUT, 'falconmed-import-template.csv'),
  toCsv([
    HEAD,
    ['A-001', 'br_lab', '2026-10-04 08:03:12', '2026-10-04 08:04:01', '2026-10-04 08:07:45', 'prescription', 'served', '1', '', 'yes', 'MRN-482913'],
    ['R-001', 'br_lab', '2026-10-04 08:05:40', '2026-10-04 08:07:52', '2026-10-04 08:09:30', 'refill', 'served', '2', '', 'yes', ''],
    ['A-002', 'br_lab', '2026-10-04 08:09:05', '2026-10-04 08:10:11', '2026-10-04 08:11:02', 'prescription', 'no_show', '1', '', 'no', ''],
  ]),
);

// ── 2. clean week (Sun 18 – Sat 24 Oct 2026) ─────────────────────
const DOW = [0.95, 1.05, 1.0, 1.0, 1.05, 0.75, 0.9];
const clean = [HEAD];
let cleanCount = 0;
for (let d = 0; d < 7; d++) {
  const date = addDays('2026-10-18', d);
  for (const t of simulateDay(Math.round(360 * DOW[d]))) {
    clean.push([
      t.ticketNo, 'br_lab', `${date} ${hms(t.arrival)}`, `${date} ${hms(t.called)}`, `${date} ${hms(t.finished)}`,
      t.service, t.noShow ? 'no_show' : 'served', String(t.counter), '', t.identified ? 'yes' : 'no',
      t.identified ? `MRN-${100000 + Math.floor(rand() * 899999)}` : '',
    ]);
    cleanCount++;
  }
}
writeFileSync(path.join(OUT, 'sample-clean-week.csv'), toCsv(clean));

// ── 3. messy export (Sun 11 – Sat 17 Oct 2026) ───────────────────
const SERVICE_LABEL = { prescription: 'New Rx', refill: 'Refill', otc: 'OTC', insurance: 'Insurance Approval', consultation: 'Counselling' };
const MESSY_HEAD = ['Token No', 'Branch Name', 'Date', 'Issue Time', 'Call Time', 'End Time', 'Service', 'Status', 'Counter', 'Patient Name', 'Mobile', 'Notes'];
const messy = [MESSY_HEAD];
const defects = {};
const mark = (k) => (defects[k] = (defects[k] || 0) + 1);
let n = 0;
for (let d = 0; d < 7; d++) {
  const date = addDays('2026-10-11', d);
  const day = simulateDay(Math.round(330 * DOW[d]));
  for (const t of day) {
    n++;
    let issue = t.arrival;
    let call = t.called;
    let end = t.finished;
    let status = t.noShow ? 'Missed' : 'Completed';
    let service = SERVICE_LABEL[t.service];
    let token = t.ticketNo;
    let notes = '';
    const r = rand();
    // ~8 % of rows carry a typical export defect
    if (r < 0.012) { [issue, call] = [call + 1.5, issue]; mark('called_before_arrival'); }
    else if (r < 0.022) { end = call - 0.8; mark('finished_before_called'); }
    else if (r < 0.03) { issue = null; mark('missing_arrival'); }
    else if (r < 0.037) { service = 'Vaccination'; mark('bad_service'); }
    else if (r < 0.047) { end = null; status = 'Serving'; mark('never_closed'); }
    else if (r < 0.057) { call = null; end = null; status = 'Cancelled'; mark('left_unseen'); }
    else if (r < 0.061) { call = issue + 150 + rand() * 40; end = call + 3; mark('long_wait'); }
    else if (r < 0.07) { notes = 'ID 784-1990-1234567-1 on file'; mark('emirates_id'); }
    const row = [
      token, 'Data Import Lab', dmy(date),
      issue === null ? '' : hm12(issue), call === null ? '' : hm12(call), end === null ? '' : hm12(end),
      service, status, `Counter ${t.counter}`, `Test Patient ${String(n).padStart(4, '0')}`, '0500000000', notes,
    ];
    messy.push(row);
    if (rand() < 0.006) { messy.push([...row]); mark('duplicate_in_file'); }
  }
}
// one late-night ticket to show the odd-hour warning
messy.push(['A-999', 'Data Import Lab', dmy('2026-10-15'), '02:15 AM', '02:16 AM', '02:19 AM', 'New Rx', 'Completed', 'Counter 1', 'Test Patient 9999', '0500000000', '']);
mark('odd_hour');
writeFileSync(path.join(OUT, 'sample-messy-export.csv'), toCsv(messy, ';'));

console.log(`template: 3 rows · clean week: ${cleanCount} rows · messy export: ${messy.length - 1} rows`);
console.log('injected defects:', defects);
