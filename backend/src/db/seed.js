/**
 * Demo data generator — `npm run seed` (add `-- --reset` to rebuild).
 *
 * Produces a realistic, reproducible pharmacy network by *simulating* each
 * day as a multi-counter queue (arrivals → wait for a free counter →
 * service), instead of writing random KPI numbers. Waiting times therefore
 * rise naturally at the 15:00–16:00 peak and fall when it eases.
 *
 * Only touches the `falconmed_v4` schema. Stores no patient names.
 */
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { migrate } from './migrate.js';
import { SERVICE_PREFIX } from '../services/queue.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DAYS = Math.min(Math.max(Number(args.days) || 60, 1), 120);
const RESET = Boolean(args.reset);

// ── deterministic random ─────────────────────────────────────────
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261023);
const pick = (weights) => {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (const [k, w] of Object.entries(weights)) if ((r -= w) <= 0) return k;
  return Object.keys(weights)[0];
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
/** Log-normal draw with the given mean (minutes) and spread. */
const lognormal = (mean, sigma = 0.45) => Math.exp(Math.log(mean) - (sigma * sigma) / 2 + sigma * gauss());

// ── network definition (fictional) ───────────────────────────────
const BRANCHES = [
  { id: 'br_ad01', name: 'Al Reem Island', city: 'Abu Dhabi', counters: 5, volume: 620 },
  { id: 'br_ad02', name: 'Khalifa City', city: 'Abu Dhabi', counters: 4, volume: 480 },
  { id: 'br_aa01', name: 'Al Ain Central', city: 'Al Ain', counters: 5, volume: 580 },
  { id: 'br_aa02', name: 'Al Jimi', city: 'Al Ain', counters: 3, volume: 420 },
  { id: 'br_dx01', name: 'Dubai Marina', city: 'Dubai', counters: 4, volume: 470 },
];

const PHARMACIST_NAMES = [
  'Lama Al-Rumaithi', 'Hana Ibrahim', 'Omar Haddad', 'Priya Nair', 'Yousef Al-Hashimi',
  'Mariam Saeed', 'Rahul Menon', 'Aisha Al-Ketbi', 'Khaled Mansour', 'Sara Al-Dhaheri',
  'Ahmed Fathy', 'Noura Al-Mazrouei', 'Joseph Mathew', 'Reem Al-Shamsi', 'Tariq Aziz',
  'Fatima Al-Nuaimi', 'Ali Raza', 'Dana Khalil', 'Hassan Qasim', 'Mona Al-Suwaidi', 'Karim Nasser',
];
const MANAGER_NAMES = ['Fatima Al-Ameri', 'Saeed Al-Kaabi', 'Huda Al-Marri', 'Imran Sheikh', 'Layla Haddad'];

// Arrivals per hour (relative), pharmacy open 08:00–23:00, peak 15:00–16:00.
const HOUR_WEIGHT = {
  8: 2.5, 9: 4.5, 10: 6, 11: 6.5, 12: 6, 13: 6.5, 14: 8, 15: 10.5, 16: 9.5,
  17: 8, 18: 7.5, 19: 7, 20: 6, 21: 4.5, 22: 2.5,
};
// Share of counters staffed by hour.
const STAFFING = (h) => (h < 10 || h >= 21 ? 0.4 : h >= 14 && h < 18 ? 0.8 : 0.6);
const DOW_FACTOR = [0.9, 1.05, 1.0, 1.0, 1.05, 0.75, 0.9]; // Sun..Sat

const SERVICE = {
  prescription: { w: 58, mean: 3.4 },
  refill: { w: 18, mean: 2.1 },
  otc: { w: 12, mean: 1.4 },
  insurance: { w: 7, mean: 5.2 },
  consultation: { w: 5, mean: 6.5 },
};
const SOURCE = { mobile: 62, kiosk: 33, walk_in: 5 };

// ── timezone helpers ─────────────────────────────────────────────
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
  return Math.round(diff / 60_000) * 60_000; // offsets are whole minutes; drop the sub-second remainder
}
/** UTC instant for local wall-clock minutes-after-midnight on a business date. */
function localToUtc(isoDate, minutes, tz) {
  const guess = new Date(`${isoDate}T00:00:00Z`).getTime() + minutes * 60_000;
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}
const todayIso = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// ── simulation ───────────────────────────────────────────────────
function simulateDay(branch, roster, isoDate, now) {
  // Rotate who covers the quieter hours so every pharmacist works a fair share.
  const shift = Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000) % roster.length;
  const staff = [...roster.slice(shift), ...roster.slice(0, shift)];
  const dow = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  const daily = Math.round(branch.volume * DOW_FACTOR[dow] * (0.9 + rand() * 0.2));
  const totalW = Object.values(HOUR_WEIGHT).reduce((a, b) => a + b, 0);

  const arrivals = [];
  for (const [h, w] of Object.entries(HOUR_WEIGHT)) {
    const n = Math.round((daily * w) / totalW + gauss() * 1.5);
    for (let i = 0; i < Math.max(0, n); i++) arrivals.push(Number(h) * 60 + rand() * 60);
  }
  arrivals.sort((a, b) => a - b);

  const freeAt = staff.map(() => 8 * 60); // per counter, minutes after midnight
  const counters = {}; // per service line numbering
  const rows = [];

  for (const arrival of arrivals) {
    const hour = Math.floor(arrival / 60);
    const active = Math.max(1, Math.ceil(staff.length * STAFFING(hour)));
    // Earliest-free counter among those staffed this hour.
    let k = 0;
    for (let i = 1; i < active; i++) if (freeAt[i] < freeAt[k]) k = i;

    const serviceType = pick(Object.fromEntries(Object.entries(SERVICE).map(([key, v]) => [key, v.w])));
    const start = Math.max(arrival, freeAt[k]) + rand() * 0.4; // a few seconds to walk up
    const noShow = rand() < 0.008;
    const duration = noShow ? 0.8 + rand() * 0.6 : Math.min(lognormal(SERVICE[serviceType].mean), 25);
    const end = start + duration;
    freeAt[k] = end;

    const arrivedAt = localToUtc(isoDate, arrival, env.TIMEZONE);
    if (arrivedAt > now) continue; // today: not arrived yet
    let calledAt = localToUtc(isoDate, start, env.TIMEZONE);
    let finishedAt = localToUtc(isoDate, end, env.TIMEZONE);
    let status = noShow ? 'no_show' : 'served';
    if (calledAt > now) {
      status = 'waiting';
      calledAt = null;
      finishedAt = null;
    } else if (finishedAt > now) {
      status = 'in_service';
      finishedAt = null;
    }

    counters[serviceType] = (counters[serviceType] || 0) + 1;
    const identified = rand() < 0.975;
    rows.push({
      branch_id: branch.id,
      service_date: isoDate,
      ticket_no: `${SERVICE_PREFIX[serviceType]}-${String(counters[serviceType]).padStart(3, '0')}`,
      service_type: serviceType,
      source: pick(SOURCE),
      identified,
      patient_ref: identified ? `MRN-${String(Math.floor(rand() * 900000) + 100000)}` : null,
      status,
      arrived_at: arrivedAt,
      called_at: calledAt,
      finished_at: finishedAt,
      pharmacist_id: status === 'waiting' ? null : staff[k].id,
      counter_no: status === 'waiting' ? null : staff[k].counter_no,
    });
  }
  return rows;
}

const COLS = [
  ['branch_id', 'text'], ['service_date', 'date'], ['ticket_no', 'text'], ['service_type', 'text'],
  ['source', 'text'], ['identified', 'boolean'], ['patient_ref', 'text'], ['status', 'text'],
  ['arrived_at', 'timestamptz'], ['called_at', 'timestamptz'], ['finished_at', 'timestamptz'],
  ['pharmacist_id', 'text'], ['counter_no', 'smallint'],
];

async function insertTickets(client, rows) {
  const CHUNK = 4000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const arrays = COLS.map(([c]) => chunk.map((r) => r[c]));
    await client.query(
      `INSERT INTO falconmed_v4.tickets (${COLS.map(([c]) => c).join(', ')})
       SELECT * FROM unnest(${COLS.map(([, t], j) => `$${j + 1}::${t}[]`).join(', ')})`,
      arrays,
    );
  }
}

export async function seed({ days = DAYS, reset = RESET, log = console.log } = {}) {
  await migrate({ log: () => {} });
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query('SELECT COUNT(*)::int AS n FROM falconmed_v4.branches');
    if (existing[0].n > 0 && !reset) {
      log('ℹ️  Demo data already present. Run `npm run seed -- --reset` to rebuild it.');
      return;
    }

    await client.query('BEGIN');
    await client.query('TRUNCATE falconmed_v4.tickets, falconmed_v4.users, falconmed_v4.branches RESTART IDENTITY CASCADE');

    const hash = await bcrypt.hash(env.DEMO_PASSWORD, 10);
    for (const b of BRANCHES) {
      await client.query('INSERT INTO falconmed_v4.branches (id, name, city, counters) VALUES ($1, $2, $3, $4)', [
        b.id, b.name, b.city, b.counters,
      ]);
    }

    const staffByBranch = {};
    let p = 0;
    for (const [bi, b] of BRANCHES.entries()) {
      staffByBranch[b.id] = [];
      for (let c = 1; c <= b.counters; c++) {
        const primary = bi === 0 && c === 1;
        const user = {
          id: `u_ph_${b.id.slice(3)}_${c}`,
          email: primary ? 'pharmacist@demo.falconmed.app' : `ph.${b.id.slice(3)}.${c}@demo.falconmed.app`,
          name: PHARMACIST_NAMES[p++ % PHARMACIST_NAMES.length],
          counter_no: c,
        };
        await client.query(
          `INSERT INTO falconmed_v4.users (id, email, full_name, role, branch_id, counter_no, password_hash)
           VALUES ($1, $2, $3, 'pharmacist', $4, $5, $6)`,
          [user.id, user.email, user.name, b.id, c, hash],
        );
        staffByBranch[b.id].push(user);
      }
      await client.query(
        `INSERT INTO falconmed_v4.users (id, email, full_name, role, branch_id, password_hash)
         VALUES ($1, $2, $3, 'manager', $4, $5)`,
        [`u_mg_${b.id.slice(3)}`, bi === 0 ? 'manager@demo.falconmed.app' : `manager.${b.id.slice(3)}@demo.falconmed.app`,
          MANAGER_NAMES[bi], b.id, hash],
      );
    }
    await client.query(
      `INSERT INTO falconmed_v4.users (id, email, full_name, role, password_hash)
       VALUES ('u_admin', 'admin@demo.falconmed.app', 'Network Administrator', 'admin', $1)`,
      [hash],
    );

    const now = new Date();
    const today = todayIso(env.TIMEZONE);
    const all = [];
    for (let d = days - 1; d >= 0; d--) {
      const iso = new Date(new Date(`${today}T00:00:00Z`).getTime() - d * 86_400_000).toISOString().slice(0, 10);
      for (const b of BRANCHES) all.push(...simulateDay(b, staffByBranch[b.id], iso, now));
    }
    await insertTickets(client, all);
    await client.query('COMMIT');

    log(`✅ Seeded ${BRANCHES.length} branches, ${Object.values(staffByBranch).flat().length} pharmacists, ` +
        `${BRANCHES.length} managers, 1 admin and ${all.length.toLocaleString()} tickets over ${days} days.`);
    log(`   Demo sign-in: pharmacist@ / manager@ / admin@demo.falconmed.app — password from DEMO_PASSWORD`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('❌ Seed failed:', err.message);
      process.exit(1);
    });
}
