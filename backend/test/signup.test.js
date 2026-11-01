/**
 * Self-service sign-up tests: a pharmacy creates its own organisation,
 * starts a free trial and is fully separated from everyone else.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool } from '../src/config/db.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';

const app = createApp();
const signup = (body) => request(app).post('/api/auth/signup').send(body);
const valid = (over = {}) => ({
  organisationName: 'Al Noor Pharmacy',
  fullName: 'Rana Haddad',
  email: 'Rana@AlNoor.example',
  password: 'AlNoor2026x',
  acceptTerms: true,
  ...over,
});
const as = (token) => ({
  get: (url) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
});
const created = [];

before(async () => {
  await pool.query('DELETE FROM falconmed_v4.rate_limits'); // rate-limit counters persist in the database
  await seed({ days: 1, reset: true, log: () => {} });
});
after(async () => {
  for (const id of created) {
    await pool.query(`DELETE FROM falconmed_v4.tickets WHERE branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = $1)`, [id]);
    await pool.query('DELETE FROM falconmed_v4.users WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.branches WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.organizations WHERE id = $1', [id]);
  }
  await pool.end();
});

let token;
test('a pharmacy signs up and is signed straight in as the admin of a new trial organisation', async () => {
  const res = await signup(valid());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { user } = res.body.data;
  token = res.body.data.token;
  created.push(user.orgId);
  assert.equal(user.role, 'admin');
  assert.equal(user.email, 'rana@alnoor.example');
  assert.equal(user.orgName, 'Al Noor Pharmacy');
  assert.equal(user.orgPlan, 'trial');
  assert.equal(user.mustChangePassword, false, 'they chose their own password');
  const days = (new Date(user.trialEndsAt) - Date.now()) / 86_400_000;
  assert.ok(days > 13.9 && days <= 14, `trial is 14 days (got ${days})`);

  const org = (await as(token).get('/api/org')).body.data;
  assert.equal(org.slug, 'al-noor-pharmacy');
  assert.deepEqual(org.setup, { branch: false, team: false, data: false });
});

test('the new organisation starts empty and sees nobody else’s data', async () => {
  assert.deepEqual((await as(token).get('/api/branches')).body.data, []);
  const sum = (await as(token).get('/api/metrics/summary')).body.data.current;
  assert.equal(sum.totalTickets, 0);
  assert.deepEqual((await as(token).get('/api/metrics/branches')).body.data, []);
  assert.equal((await as(token).get('/api/imports')).body.data.length, 0);
  assert.equal((await as(token).get('/api/metrics/summary?branchId=br_ad01')).status, 403);
});

test('the getting-started checklist follows real progress', async () => {
  const b = await as(token).post('/api/org/branches', { name: 'Main', city: 'Al Ain', counters: 2 });
  assert.equal(b.status, 201);
  let setup = (await as(token).get('/api/org')).body.data.setup;
  assert.deepEqual(setup, { branch: true, team: false, data: false });

  await as(token).post('/api/org/users', { fullName: 'Omar', email: 'omar@alnoor.example', role: 'pharmacist', branchId: b.body.data.id, counterNo: 1 });
  await as(token).post('/api/queue/tickets', { branchId: b.body.data.id });
  setup = (await as(token).get('/api/org')).body.data.setup;
  assert.deepEqual(setup, { branch: true, team: true, data: true });
});

test('the same organisation name gets its own unique ID', async () => {
  const res = await signup(valid({ email: 'second@alnoor.example' }));
  assert.equal(res.status, 201);
  created.push(res.body.data.user.orgId);
  const org = (await as(res.body.data.token).get('/api/org')).body.data;
  assert.match(org.slug, /^al-noor-pharmacy-[0-9a-f]{4}$/);
  assert.notEqual(res.body.data.user.orgId, created[0]);
});

test('sign-up is validated: existing email, weak password, missing consent, bots', async () => {
  const dup = await signup(valid({ email: 'admin@demo.falconmed.app' }));
  assert.equal(dup.status, 409);
  assert.equal((await signup(valid({ email: 'x1@x.example', password: 'short' }))).status, 400);
  assert.equal((await signup(valid({ email: 'x2@x.example', acceptTerms: false }))).status, 400);
  assert.equal((await signup(valid({ email: 'x3@x.example', organisationName: ' ' }))).status, 400);
  assert.equal((await signup(valid({ email: 'x4@x.example', website: 'http://spam.example' }))).status, 400, 'honeypot');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE email LIKE 'x_@x.example'`);
  assert.equal(rows[0].n, 0, 'nothing was created');
});

test('demo refreshes never remove signed-up organisations', async () => {
  await seed({ days: 1, reset: true, log: () => {} });
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE org_id = $1', [created[0]]);
  assert.equal(rows[0].n, 2);
});
