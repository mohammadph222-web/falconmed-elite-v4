/**
 * Demo data generator — `npm run seed` (or `npm run seed:refresh` to rebuild
 * it so the data runs up to today).
 *
 * Creates two fictional demo organisations on the same platform, to show
 * that each organisation only ever sees its own data. A rebuild only touches
 * organisations whose plan is 'demo' — real customers are never affected.
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
import { localToUtc } from '../lib/time.js';

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

// ── demo organisations (fictional) ───────────────────────────────
const ORGS = [
  {
    id: 'org_demo',
    name: 'FalconMed Demo Network',
    slug: 'demo',
    domain: 'demo.falconmed.app',
    primaryLogins: true, // pharmacist@ / manager@ / admin@demo.falconmed.app
    admin: { id: 'u_admin', name: 'Network Administrator' },
    lab: 'br_lab',
    branches: [
      { id: 'br_ad01', name: 'Al Reem Island', city: 'Abu Dhabi', counters: 5, volume: 620 },
      { id: 'br_ad02', name: 'Khalifa City', city: 'Abu Dhabi', counters: 4, volume: 480 },
      { id: 'br_aa01', name: 'Al Ain Central', city: 'Al Ain', counters: 5, volume: 580 },
      { id: 'br_aa02', name: 'Al Jimi', city: 'Al Ain', counters: 3, volume: 420 },
      { id: 'br_dx01', name: 'Dubai Marina', city: 'Dubai', counters: 4, volume: 470 },
    ],
    pharmacists: [
      'Lama Al-Rumaithi', 'Hana Ibrahim', 'Omar Haddad', 'Priya Nair', 'Yousef Al-Hashimi',
      'Mariam Saeed', 'Rahul Menon', 'Aisha Al-Ketbi', 'Khaled Mansour', 'Sara Al-Dhaheri',
      'Ahmed Fathy', 'Noura Al-Mazrouei', 'Joseph Mathew', 'Reem Al-Shamsi', 'Tariq Aziz',
      'Fatima Al-Nuaimi', 'Ali Raza', 'Dana Khalil', 'Hassan Qasim', 'Mona Al-Suwaidi', 'Karim Nasser',
    ],
    managers: ['Fatima Al-Ameri', 'Saeed Al-Kaabi', 'Huda Al-Marri', 'Imran Sheikh', 'Layla Haddad'],
  },
  {
    id: 'org_oasis',
    name: 'Oasis Care Pharmacies',
    slug: 'oasis',
    domain: 'oasis.demo.falconmed.app',
    primaryLogins: false,
    admin: { id: 'u_admin_oasis', name: 'Group Operations Lead' },
    lab: 'br_os_lab',
    branches: [
      { id: 'br_os01', name: 'Al Majaz', city: 'Sharjah', counters: 3, volume: 240 },
      { id: 'br_os02', name: 'Al Nahda', city: 'Sharjah', counters: 3, volume: 200 },
    ],
    pharmacists: ['Zainab Al-Hammadi', 'Vikram Rao', 'Salma Youssef', 'Faisal Al-Owais', 'Nadia Karam', 'George Thomas'],
    managers: ['Rania Al-Zarooni', 'Bilal Chaudhry'],
  },
];

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

// ── timezone helpers (shared) ───────────────────────────────────
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

export async function seed({ days = DAYS, reset = RESET, log = console.log, skipIfBusy = false } = {}) {
  await migrate({ log: () => {} });
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query(
      `SELECT COUNT(*)::int AS n FROM falconmed_v4.users u
         JOIN falconmed_v4.organizations o ON o.id = u.org_id WHERE o.plan = 'demo'`,
    );
    if (existing[0].n > 0 && !reset) {
      log('ℹ️  Demo data already present. Run `npm run seed:refresh` to rebuild it up to today.');
      return;
    }

    await client.query('BEGIN');
    // One rebuild at a time (two server instances may start together during a deploy).
    if (skipIfBusy) {
      const { rows: lock } = await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('falconmed_demo_seed')) AS ok`);
      if (!lock[0].ok) {
        await client.query('ROLLBACK');
        log('ℹ️  Another instance is already rebuilding the demo data.');
        return;
      }
    } else {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('falconmed_demo_seed'))`);
    }
    for (const o of ORGS) {
      await client.query(
        `INSERT INTO falconmed_v4.organizations (id, name, slug, plan) VALUES ($1, $2, $3, 'demo')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, plan = 'demo', is_active = TRUE`,
        [o.id, o.name, o.slug],
      );
    }
    // Wipe demo organisations only. Paying organisations are never touched.
    const demo = `SELECT id FROM falconmed_v4.organizations WHERE plan = 'demo'`;
    await client.query(`DELETE FROM falconmed_v4.tickets
                         WHERE branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id IN (${demo}))`);
    await client.query(`DELETE FROM falconmed_v4.import_batches WHERE org_id IN (${demo})`);
    await client.query(`DELETE FROM falconmed_v4.users WHERE org_id IN (${demo})`);
    await client.query(`DELETE FROM falconmed_v4.branches WHERE org_id IN (${demo})`);

    const hash = await bcrypt.hash(env.DEMO_PASSWORD, 10);
    const now = new Date();
    const today = todayIso(env.TIMEZONE);
    const all = [];
    const totals = { branches: 0, pharmacists: 0, managers: 0, admins: 0 };

    for (const o of ORGS) {
      const staffByBranch = {};
      let p = 0;
      for (const [bi, b] of o.branches.entries()) {
        await client.query(
          'INSERT INTO falconmed_v4.branches (id, org_id, name, city, counters) VALUES ($1, $2, $3, $4, $5)',
          [b.id, o.id, b.name, b.city, b.counters],
        );
        staffByBranch[b.id] = [];
        for (let c = 1; c <= b.counters; c++) {
          const primary = o.primaryLogins && bi === 0 && c === 1;
          const user = {
            id: `u_ph_${b.id.slice(3)}_${c}`,
            email: primary ? `pharmacist@${o.domain}` : `ph.${b.id.slice(3)}.${c}@${o.domain}`,
            name: o.pharmacists[p++ % o.pharmacists.length],
            counter_no: c,
          };
          await client.query(
            `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, branch_id, counter_no, password_hash)
             VALUES ($1, $2, $3, $4, 'pharmacist', $5, $6, $7)`,
            [user.id, o.id, user.email, user.name, b.id, c, hash],
          );
          staffByBranch[b.id].push(user);
        }
        const primaryManager = o.primaryLogins && bi === 0;
        await client.query(
          `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, branch_id, password_hash)
           VALUES ($1, $2, $3, $4, 'manager', $5, $6)`,
          [`u_mg_${b.id.slice(3)}`, o.id, primaryManager ? `manager@${o.domain}` : `manager.${b.id.slice(3)}@${o.domain}`,
            o.managers[bi % o.managers.length], b.id, hash],
        );
        totals.managers++;
      }
      await client.query(
        `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, password_hash)
         VALUES ($1, $2, $3, $4, 'admin', $5)`,
        [o.admin.id, o.id, `admin@${o.domain}`, o.admin.name, hash],
      );
      // Empty sandbox branch for trying the CSV importer.
      await client.query(
        `INSERT INTO falconmed_v4.branches (id, org_id, name, city, counters) VALUES ($1, $2, 'Data Import Lab', 'Sandbox', 4)`,
        [o.lab, o.id],
      );

      for (let d = days - 1; d >= 0; d--) {
        const iso = new Date(new Date(`${today}T00:00:00Z`).getTime() - d * 86_400_000).toISOString().slice(0, 10);
        for (const b of o.branches) all.push(...simulateDay(b, staffByBranch[b.id], iso, now));
      }
      totals.branches += o.branches.length;
      totals.pharmacists += Object.values(staffByBranch).flat().length;
      totals.admins++;
    }
    await insertTickets(client, all);
    await client.query('COMMIT');

    log(`✅ Seeded ${ORGS.length} demo organisations: ${totals.branches} branches, ${totals.pharmacists} pharmacists, ` +
        `${totals.managers} managers, ${totals.admins} admins and ${all.length.toLocaleString()} tickets over ${days} days (up to today).`);
    log('   Demo sign-in: pharmacist@ / manager@ / admin@demo.falconmed.app and admin@oasis.demo.falconmed.app — password from DEMO_PASSWORD');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * True when the demo needs rebuilding: an organisation is missing, or the
 * newest demo ticket arrived more than `maxAgeHours` ago.
 */
export async function demoIsStale({ maxAgeHours = 12 } = {}) {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM falconmed_v4.organizations WHERE id = ANY($1) AND plan = 'demo') AS orgs,
            (SELECT MAX(arrived_at) FROM falconmed_v4.tickets
              WHERE branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = ANY($1))) AS newest`,
    [ORGS.map((o) => o.id)],
  );
  const { orgs, newest } = rows[0];
  return orgs < ORGS.length || !newest || Date.now() - new Date(newest).getTime() > maxAgeHours * 3_600_000;
}

/** Rebuild the demo organisations if they are out of date (see DEMO_AUTO_REFRESH). */
export async function refreshDemoIfStale({ log = console.log } = {}) {
  if (!(await demoIsStale())) return false;
  log('🔄 Demo data is out of date — rebuilding it up to now…');
  await seed({ reset: true, log, skipIfBusy: true });
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('❌ Seed failed:', err.message);
      process.exit(1);
    });
}
