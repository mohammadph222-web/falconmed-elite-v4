/**
 * Multi-tenancy tests — two demo organisations share one database and one
 * API, and neither can see or change the other's data. Run against a real
 * PostgreSQL (see api.test.js header).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import request from 'supertest';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { todayISO } from '../src/lib/scope.js';

const app = createApp();
const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/public/samples');
const today = todayISO();
const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
const range = `from=${weekAgo}&to=${today}`;
const tokens = {};

const login = (email) => request(app).post('/api/auth/login').send({ email, password: env.DEMO_PASSWORD });
const as = (who) => ({
  get: (url) => request(app).get(url).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url, body = {}) => request(app).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  del: (url) => request(app).delete(url).set('Authorization', `Bearer ${tokens[who]}`),
});
const rawCount = async (orgId) =>
  (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets
        WHERE service_date BETWEEN $1 AND $2
          AND branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = $3)`,
      [weekAgo, today, orgId],
    )
  ).rows[0].n;

before(async () => {
  await pool.query('DELETE FROM falconmed_v4.rate_limits'); // rate-limit counters persist in the database
  await seed({ days: 7, reset: true, log: () => {} });
  for (const [k, email] of Object.entries({
    demoAdmin: 'admin@demo.falconmed.app',
    demoManager: 'manager@demo.falconmed.app',
    oasisAdmin: 'admin@oasis.demo.falconmed.app',
    oasisManager: 'manager.os01@oasis.demo.falconmed.app',
  })) {
    const res = await login(email);
    assert.equal(res.status, 200, `${email}: ${JSON.stringify(res.body)}`);
    tokens[k] = res.body.data.token;
  }
});
after(() => pool.end());

test('every user is told which organisation they belong to', async () => {
  const me = (await as('oasisAdmin').get('/api/auth/me')).body.data;
  assert.equal(me.orgId, 'org_oasis');
  assert.equal(me.orgName, 'Oasis Care Pharmacies');
  const demo = (await as('demoAdmin').get('/api/auth/me')).body.data;
  assert.equal(demo.orgName, 'FalconMed Demo Network');
});

test('the login screen lists demo accounts from both organisations', async () => {
  const list = (await request(app).get('/api/auth/demo-accounts')).body.data;
  assert.deepEqual(list.map((a) => a.email), [
    'pharmacist@demo.falconmed.app', 'manager@demo.falconmed.app', 'admin@demo.falconmed.app', 'admin@oasis.demo.falconmed.app',
  ]);
  assert.equal(list[3].orgName, 'Oasis Care Pharmacies');
});

test('branch lists contain only the organisation’s own branches', async () => {
  const oasis = (await as('oasisAdmin').get('/api/branches')).body.data.map((b) => b.id).sort();
  assert.deepEqual(oasis, ['br_os01', 'br_os02', 'br_os_lab']);
  const demo = (await as('demoAdmin').get('/api/branches')).body.data.map((b) => b.id);
  assert.equal(demo.length, 6);
  assert.ok(!demo.some((id) => id.startsWith('br_os')));

  const scorecard = (await as('oasisAdmin').get(`/api/metrics/branches?${range}`)).body.data.map((b) => b.id).sort();
  assert.deepEqual(scorecard, ['br_os01', 'br_os02', 'br_os_lab']);
});

test('network KPIs count only the organisation’s own tickets', async () => {
  const oasis = (await as('oasisAdmin').get(`/api/metrics/summary?${range}`)).body.data.current.totalTickets;
  const demo = (await as('demoAdmin').get(`/api/metrics/summary?${range}`)).body.data.current.totalTickets;
  assert.equal(oasis, await rawCount('org_oasis'));
  assert.equal(demo, await rawCount('org_demo'));
  assert.ok(oasis > 0 && demo > oasis);

  for (const ep of ['daily', 'hourly', 'mix']) {
    const res = await as('oasisAdmin').get(`/api/metrics/${ep}?${range}`);
    assert.equal(res.status, 200, ep);
  }
  const days = (await as('oasisAdmin').get(`/api/metrics/daily?${range}`)).body.data;
  assert.equal(days.reduce((s, d) => s + d.tickets, 0), oasis);

  const staff = (await as('oasisAdmin').get(`/api/metrics/staff?${range}`)).body.data;
  assert.equal(staff.length, 6);
  assert.ok(staff.every((s) => s.branchId.startsWith('br_os')));
});

test('asking for another organisation’s branch or pharmacist is refused', async () => {
  for (const url of [
    `/api/metrics/summary?${range}&branchId=br_ad01`,
    `/api/metrics/staff?${range}&branchId=br_ad01`,
    `/api/metrics/summary?${range}&pharmacistId=u_ph_ad01_1`,
    '/api/queue/live?branchId=br_ad01',
  ]) {
    const res = await as('oasisAdmin').get(url);
    assert.equal(res.status, 403, url);
  }
  const back = await as('demoAdmin').get(`/api/metrics/summary?${range}&branchId=br_os01`);
  assert.equal(back.status, 403);
});

test('the live board shows only the organisation’s own queue', async () => {
  const add = await as('demoAdmin').post('/api/queue/tickets', { branchId: 'br_ad01', serviceType: 'otc' });
  assert.equal(add.status, 201);
  const oasis = (await as('oasisAdmin').get('/api/queue/live')).body.data;
  assert.ok([...oasis.waiting, ...oasis.inService].every((t) => t.branchId.startsWith('br_os')));
  const demo = (await as('demoAdmin').get('/api/queue/live')).body.data;
  assert.ok(demo.waiting.some((t) => t.id === add.body.data.id));
  assert.equal(oasis.counts.counters, 10); // 3 + 3 + 4 (sandbox)
});

test('the simulator cannot create tickets in another organisation', async () => {
  const res = await as('oasisAdmin').post('/api/queue/tickets', { branchId: 'br_ad01' });
  assert.equal(res.status, 403);
  const ok = await as('oasisAdmin').post('/api/queue/tickets', { branchId: 'br_os01' });
  assert.equal(ok.status, 201);
});

test('imports stay inside the organisation: other branches are invisible, history and rollback are private', async () => {
  // The template names the demo organisation's sandbox id; Oasis cannot see it.
  const template = readFileSync(path.join(SAMPLES, 'falconmed-import-template.csv'), 'utf8');
  const blocked = (await as('oasisAdmin').post('/api/imports/validate', { csv: template })).body.data;
  assert.equal(blocked.summary.valid, 0);
  assert.equal(blocked.issues.find((i) => i.code === 'unknown_branch').count, 3);

  // The branch *name* resolves to Oasis's own sandbox.
  const csv = template.replaceAll('br_lab', 'Data Import Lab');
  const imp = await as('oasisAdmin').post('/api/imports', { csv, fileName: 'oasis.csv' });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.data.report.summary.branches.map((b) => b.id), ['br_os_lab']);
  const { batchId } = imp.body.data;

  const demoHistory = (await as('demoAdmin').get('/api/imports')).body.data;
  assert.ok(!demoHistory.some((b) => b.id === batchId), 'another organisation must not see the import');
  assert.equal((await as('demoAdmin').del(`/api/imports/${batchId}`)).status, 404, 'nor roll it back');

  const oasisHistory = (await as('oasisAdmin').get('/api/imports')).body.data;
  assert.ok(oasisHistory.some((b) => b.id === batchId));
  assert.equal((await as('oasisAdmin').del(`/api/imports/${batchId}`)).body.data.rowsRemoved, 3);
});

test('a manager in one organisation cannot reach the other organisation either', async () => {
  const res = await as('oasisManager').get(`/api/metrics/summary?${range}`);
  assert.equal(res.body.scope.branchId, 'br_os01');
  assert.equal((await as('oasisManager').get(`/api/metrics/summary?${range}&branchId=br_ad01`)).status, 403);
  assert.equal((await as('demoManager').get('/api/queue/live?branchId=br_os01')).status, 403);
});

test('the database itself refuses a user whose branch belongs to another organisation', async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, branch_id, counter_no, password_hash)
       VALUES ('u_bad', 'org_oasis', 'bad@example.com', 'Bad', 'pharmacist', 'br_ad01', 49, 'x')`,
    ),
    /users_branch_same_org/,
  );
});

test('suspending an organisation signs its users out and blocks sign-in', async () => {
  await pool.query(`UPDATE falconmed_v4.organizations SET is_active = FALSE WHERE id = 'org_oasis'`);
  try {
    assert.equal((await as('oasisAdmin').get('/api/auth/me')).status, 401);
    assert.equal((await login('admin@oasis.demo.falconmed.app')).status, 401);
    assert.equal((await as('demoAdmin').get('/api/auth/me')).status, 200, 'other organisations unaffected');
    const list = (await request(app).get('/api/auth/demo-accounts')).body.data;
    assert.ok(!list.some((a) => a.email.includes('oasis')));
  } finally {
    await pool.query(`UPDATE falconmed_v4.organizations SET is_active = TRUE WHERE id = 'org_oasis'`);
  }
});

test('refreshing the demo data never touches a real (non-demo) organisation', async () => {
  await pool.query(`INSERT INTO falconmed_v4.organizations (id, name, slug, plan) VALUES ('org_paid', 'Paying Customer', 'paying', 'pro')`);
  await pool.query(`INSERT INTO falconmed_v4.branches (id, org_id, name, city) VALUES ('br_paid', 'org_paid', 'Main', 'Dubai')`);
  await pool.query(
    `INSERT INTO falconmed_v4.tickets (branch_id, service_date, ticket_no, status) VALUES ('br_paid', $1, 'P-001', 'waiting')`,
    [today],
  );
  try {
    await seed({ days: 2, reset: true, log: () => {} });
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets WHERE branch_id = 'br_paid'`);
    assert.equal(rows[0].n, 1);
    const demo = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE org_id = 'org_demo'`);
    assert.ok(demo.rows[0].n > 0, 'demo organisation rebuilt');
  } finally {
    await pool.query(`DELETE FROM falconmed_v4.tickets WHERE branch_id = 'br_paid'`);
    await pool.query(`DELETE FROM falconmed_v4.branches WHERE id = 'br_paid'`);
    await pool.query(`DELETE FROM falconmed_v4.organizations WHERE id = 'org_paid'`);
  }
});

test('demo auto-refresh only rebuilds when the demo data is out of date', async () => {
  const { demoIsStale, refreshDemoIfStale } = await import('../src/db/seed.js');
  await seed({ days: 1, reset: true, log: () => {} });
  assert.equal(await demoIsStale(), false, 'just rebuilt');
  assert.equal(await refreshDemoIfStale({ log: () => {} }), false);
  // Age every demo ticket by two days: now it is stale.
  await pool.query(`UPDATE falconmed_v4.tickets SET arrived_at = arrived_at - interval '2 days',
                      called_at = called_at - interval '2 days', finished_at = finished_at - interval '2 days'`);
  assert.equal(await demoIsStale(), true);
  assert.equal(await refreshDemoIfStale({ log: () => {} }), true);
  assert.equal(await demoIsStale(), false);
});
