/**
 * End-to-end API tests against a real PostgreSQL database.
 * Requires DATABASE_URL to point at a disposable database — the suite
 * reseeds the `falconmed_v4` schema. Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { todayISO } from '../src/lib/scope.js';

const app = createApp();
const tokens = {};
const today = todayISO();
const monthAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: env.DEMO_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data.token;
};
const get = (role, url) => request(app).get(url).set('Authorization', `Bearer ${tokens[role]}`);
const post = (role, url, body = {}) => request(app).post(url).set('Authorization', `Bearer ${tokens[role]}`).send(body);

before(async () => {
  await pool.query('DELETE FROM falconmed_v4.rate_limits'); // rate-limit counters persist in the database
  await seed({ days: 14, reset: true, log: () => {} });
  tokens.pharmacist = await login('pharmacist@demo.falconmed.app');
  tokens.manager = await login('manager@demo.falconmed.app');
  tokens.admin = await login('admin@demo.falconmed.app');
  tokens.otherPharmacist = await login('ph.ad01.2@demo.falconmed.app');
});

after(() => pool.end());

// ── authentication ──────────────────────────────────────────────
test('health check reports database up', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.database, 'up');
});

test('wrong password is rejected without revealing which part was wrong', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'admin@demo.falconmed.app', password: 'nope' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Incorrect email or password');
});

test('protected endpoints require a token', async () => {
  const res = await request(app).get('/api/metrics/summary');
  assert.equal(res.status, 401);
});

test('a forged token is rejected', async () => {
  const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer abc.def.ghi');
  assert.equal(res.status, 401);
});

test('login response never contains the password hash', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'admin@demo.falconmed.app', password: env.DEMO_PASSWORD });
  assert.ok(!JSON.stringify(res.body).includes('password'));
});

// ── role scoping ────────────────────────────────────────────────
test('pharmacist cannot read another branch or another pharmacist', async () => {
  assert.equal((await get('pharmacist', '/api/metrics/summary?branchId=br_aa01')).status, 403);
  assert.equal((await get('pharmacist', '/api/metrics/summary?pharmacistId=u_ph_ad01_2')).status, 403);
  assert.equal((await get('pharmacist', '/api/metrics/staff')).status, 403);
});

test('manager is locked to own branch; admin sees the network', async () => {
  assert.equal((await get('manager', '/api/metrics/summary?branchId=br_dx01')).status, 403);
  assert.equal((await get('manager', '/api/metrics/branches')).status, 403);
  const m = await get('manager', '/api/metrics/summary');
  assert.equal(m.body.scope.branchId, 'br_ad01');
  const a = await get('admin', '/api/metrics/summary');
  assert.equal(a.body.scope.level, 'network');
});

// ── input validation & injection ────────────────────────────────
test('malformed and malicious dates are rejected, not executed', async () => {
  const bad = await get('admin', `/api/metrics/summary?from=${encodeURIComponent("2026-01-01' OR '1'='1")}`);
  assert.equal(bad.status, 400);
  assert.equal((await get('admin', '/api/metrics/summary?from=2026-02-30')).status, 400);
  assert.equal((await get('admin', '/api/metrics/summary?from=2026-05-01&to=2026-04-01')).status, 400);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets');
  assert.ok(rows[0].n > 0, 'tickets table still intact');
});

test('patient names are refused as patientRef', async () => {
  const res = await post('admin', '/api/queue/tickets', { branchId: 'br_ad01', patientRef: 'Ahmed Ali' });
  assert.equal(res.status, 400);
});

// ── metric correctness ──────────────────────────────────────────
test('summary KPIs reconcile with raw ticket data', async () => {
  const res = await get('admin', `/api/metrics/summary?from=${monthAgo}&to=${today}`);
  assert.equal(res.status, 200);
  const k = res.body.data.current;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='served')::int AS served,
            COUNT(*) FILTER (WHERE status='no_show')::int AS no_show,
            AVG(EXTRACT(EPOCH FROM (called_at - arrived_at))/60) AS avg_wait,
            AVG(EXTRACT(EPOCH FROM (finished_at - called_at))/60) FILTER (WHERE status='served') AS avg_service
       FROM falconmed_v4.tickets WHERE service_date BETWEEN $1 AND $2 AND branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = 'org_demo')`,
    [monthAgo, today],
  );
  const r = rows[0];
  assert.equal(k.totalTickets, r.total);
  assert.equal(k.served, r.served);
  assert.equal(k.noShow, r.no_show);
  assert.equal(k.serveRate, Number(((r.served / (r.served + r.no_show)) * 100).toFixed(1)));
  assert.equal(k.avgWaitMin, Number(Number(r.avg_wait).toFixed(2)));
  assert.equal(k.avgServiceMin, Number(Number(r.avg_service).toFixed(2)));
  assert.ok(k.totalTickets > 1000, 'seed produced a meaningful volume');
});

test('staff are pharmacists (not patients) and their counts add up to the branch', async () => {
  const staff = await get('manager', `/api/metrics/staff?from=${monthAgo}&to=${today}`);
  const sum = await get('manager', `/api/metrics/summary?from=${monthAgo}&to=${today}`);
  const ids = staff.body.data.map((s) => s.id);
  assert.ok(ids.every((id) => id.startsWith('u_ph_ad01_')));
  const served = staff.body.data.reduce((s, x) => s + x.served, 0);
  assert.equal(served, sum.body.data.current.served);
});

test('hourly series has 24 hours and peaks in the afternoon', async () => {
  const res = await get('admin', `/api/metrics/hourly?from=${monthAgo}&to=${today}`);
  assert.equal(res.body.data.length, 24);
  const peak = res.body.data.reduce((a, b) => (b.tickets > a.tickets ? b : a));
  assert.ok(peak.hour >= 14 && peak.hour <= 17, `peak hour was ${peak.hour}`);
});

test('daily series has one row per day, including empty days', async () => {
  const res = await get('admin', '/api/metrics/daily?from=2020-01-01&to=2020-01-07');
  assert.equal(res.body.data.length, 7);
  assert.ok(res.body.data.every((d) => d.tickets === 0 && d.serveRate === null));
});

test('no metric is a hard-coded constant: empty period returns nulls, not 99.3 or 4.8', async () => {
  const res = await get('admin', '/api/metrics/summary?from=2020-01-01&to=2020-01-01');
  const k = res.body.data.current;
  assert.equal(k.totalTickets, 0);
  assert.equal(k.serveRate, null);
  assert.equal(k.noShowRate, null);
  assert.equal(k.avgWaitMin, null);
  assert.ok(!('rating' in k));
});

test('branch comparison covers every branch (5 live + import lab) with a derived status', async () => {
  const res = await get('admin', `/api/metrics/branches?from=${monthAgo}&to=${today}`);
  assert.equal(res.body.data.length, 6);
  assert.equal(res.body.data.find((b) => b.id === 'br_lab').status, 'no_data');
  assert.ok(res.body.data.every((b) => ['on_target', 'watch', 'action', 'no_data'].includes(b.status)));
});

// ── live queue workflow ─────────────────────────────────────────
test('kiosk registers tickets with the queue key; bad key is refused', async () => {
  const bad = await request(app).post('/api/queue/tickets').set('X-Queue-Key', 'wrong-key-123').send({ branchId: 'br_ad01' });
  assert.equal(bad.status, 401);
  const ok = await request(app)
    .post('/api/queue/tickets')
    .set('X-Queue-Key', env.QUEUE_API_KEY)
    .send({ branchId: 'br_ad01', serviceType: 'refill', source: 'mobile', patientRef: 'MRN-123456' });
  assert.equal(ok.status, 201);
  assert.match(ok.body.data.ticketNo, /^R-\d{3}$/);
  assert.equal(ok.body.data.status, 'waiting');
});

test('manager cannot register tickets for another branch', async () => {
  const res = await post('manager', '/api/queue/tickets', { branchId: 'br_dx01' });
  assert.equal(res.status, 403);
});

test('call-next → complete: two counters never receive the same ticket', async () => {
  // clear anything already at these counters
  for (const role of ['pharmacist', 'otherPharmacist']) {
    const cur = await get(role, '/api/queue/current');
    if (cur.body.data) await post(role, `/api/queue/tickets/${cur.body.data.id}/complete`, { outcome: 'served' });
  }
  await post('admin', '/api/queue/tickets', { branchId: 'br_ad01', serviceType: 'prescription' });
  await post('admin', '/api/queue/tickets', { branchId: 'br_ad01', serviceType: 'otc' });

  const [a, b] = await Promise.all([post('pharmacist', '/api/queue/call-next'), post('otherPharmacist', '/api/queue/call-next')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(a.body.data && b.body.data);
  assert.notEqual(a.body.data.id, b.body.data.id);
  assert.equal(a.body.data.status, 'in_service');

  // cannot call another while one is open
  const again = await post('pharmacist', '/api/queue/call-next');
  assert.equal(again.status, 409);

  // cannot close someone else's ticket
  const steal = await post('pharmacist', `/api/queue/tickets/${b.body.data.id}/complete`);
  assert.equal(steal.status, 404);

  const done = await post('pharmacist', `/api/queue/tickets/${a.body.data.id}/complete`, { outcome: 'served' });
  assert.equal(done.body.data.status, 'served');
  const ns = await post('otherPharmacist', `/api/queue/tickets/${b.body.data.id}/complete`, { outcome: 'no_show' });
  assert.equal(ns.body.data.status, 'no_show');
});

test('live board returns open tickets, last-hour pulse and alerts', async () => {
  const res = await get('manager', '/api/queue/live');
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.ok(Array.isArray(d.waiting) && Array.isArray(d.inService) && Array.isArray(d.alerts));
  assert.ok(d.waiting.every((t) => t.branchId === 'br_ad01'));
  assert.equal(d.counts.counters, 5);
});

test('tickets left open from a previous day are closed honestly, not left blocking counters', async () => {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO falconmed_v4.tickets (branch_id, service_date, ticket_no, arrived_at)
     VALUES ('br_ad02', $1::date, 'Z-901', now() - interval '1 day')`,
    [yesterday],
  );
  // free the counter first: a pharmacist can hold only one open ticket
  await pool.query(
    `UPDATE falconmed_v4.tickets SET status = 'served', finished_at = now()
      WHERE pharmacist_id = 'u_ph_ad02_4' AND status = 'in_service'`,
  );
  await pool.query(
    `INSERT INTO falconmed_v4.tickets (branch_id, service_date, ticket_no, arrived_at, called_at, status, pharmacist_id, counter_no)
     VALUES ('br_ad02', $1::date, 'Z-902', now() - interval '1 day', now() - interval '1 day' + interval '2 minutes', 'in_service', 'u_ph_ad02_4', 4)`,
    [yesterday],
  );
  await get('admin', '/api/queue/live?branchId=br_ad02');
  const { rows } = await pool.query(
    `SELECT ticket_no, status FROM falconmed_v4.tickets WHERE ticket_no IN ('Z-901','Z-902') ORDER BY ticket_no`,
  );
  assert.deepEqual(rows.map((r) => r.status), ['abandoned', 'auto_closed']);
  const s = await get('admin', `/api/metrics/summary?branchId=br_ad02&from=${yesterday}&to=${yesterday}`);
  assert.ok(s.body.data.current.abandoned >= 1);
});

test('a period ending today is compared with the previous period up to the same time, not a full day', async () => {
  const res = await get('admin', `/api/metrics/summary?from=${today}&to=${today}`);
  assert.equal(res.status, 200);
  const d = res.body.data;
  assert.equal(d.comparison.mode, 'same_time');
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS upto, (SELECT COUNT(*)::int FROM falconmed_v4.tickets WHERE service_date = $1 AND branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = 'org_demo')) AS full_day
       FROM falconmed_v4.tickets WHERE service_date = $1 AND arrived_at <= $2::timestamptz AND branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = 'org_demo')`,
    [yesterday, d.comparison.previousCutoff],
  );
  assert.equal(d.previous.totalTickets, rows[0].upto, 'previous = yesterday until the same time');
  assert.ok(rows[0].upto <= rows[0].full_day);
});

test('a completed period is compared with the full previous period', async () => {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const res = await get('admin', `/api/metrics/summary?from=${yesterday}&to=${yesterday}`);
  assert.equal(res.body.data.comparison.mode, 'full_period');
  assert.equal(res.body.data.comparison.previousCutoff, null);
  const dayBefore = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets WHERE service_date = $1 AND branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = 'org_demo')`, [dayBefore]);
  assert.equal(res.body.data.previous.totalTickets, rows[0].n);
});
