/**
 * Organisation settings tests: admins manage their own branches and team,
 * temporary passwords, password changes, and protected demo records.
 * Runs against a real PostgreSQL (see api.test.js header).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';

const app = createApp();
const tokens = {};
const login = (email, password = env.DEMO_PASSWORD) => request(app).post('/api/auth/login').send({ email, password });
const as = (token) => ({
  get: (url) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url, body = {}) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
});
const admin = () => as(tokens.admin);

before(async () => {
  await seed({ days: 2, reset: true, log: () => {} });
  // A real (non-demo) organisation, so editing rules can be tested without demo protection.
  await pool.query(`INSERT INTO falconmed_v4.organizations (id, name, slug, plan, trial_ends_at) VALUES ('org_test', 'Test Pharmacies', 'test-pharmacies', 'trial', now() + interval '14 days')`);
  await pool.query(
    `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, password_hash)
     VALUES ('u_test_admin', 'org_test', 'owner@test.example', 'Test Owner', 'admin', $1)`,
    [(await pool.query('SELECT password_hash FROM falconmed_v4.users WHERE id = $1', ['u_admin'])).rows[0].password_hash],
  );
  tokens.admin = (await login('owner@test.example')).body.data.token;
  tokens.demoAdmin = (await login('admin@demo.falconmed.app')).body.data.token;
  tokens.manager = (await login('manager@demo.falconmed.app')).body.data.token;
  tokens.oasisAdmin = (await login('admin@oasis.demo.falconmed.app')).body.data.token;
});
after(async () => {
  await pool.query(`DELETE FROM falconmed_v4.tickets WHERE branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = 'org_test')`);
  await pool.query(`DELETE FROM falconmed_v4.users WHERE org_id = 'org_test'`);
  await pool.query(`DELETE FROM falconmed_v4.branches WHERE org_id = 'org_test'`);
  await pool.query(`DELETE FROM falconmed_v4.organizations WHERE id = 'org_test'`);
  await pool.end();
});

test('only organisation admins can open settings', async () => {
  assert.equal((await as(tokens.manager).get('/api/org')).status, 403);
  assert.equal((await request(app).get('/api/org')).status, 401);
  const org = (await admin().get('/api/org')).body.data;
  assert.equal(org.name, 'Test Pharmacies');
  assert.equal(org.demoProtected, false);
});

test('an admin can rename their organisation', async () => {
  const res = await admin().patch('/api/org', { name: 'Test Pharmacy Group' });
  assert.equal(res.status, 200);
  assert.equal((await admin().get('/api/auth/me')).body.data.orgName, 'Test Pharmacy Group');
});

let branchId;
test('add and edit a branch; names are unique inside the organisation', async () => {
  const res = await admin().post('/api/org/branches', { name: 'Downtown', city: 'Dubai', counters: 2 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  branchId = res.body.data.id;
  assert.match(branchId, /^br_[0-9a-f]{10}$/);
  assert.equal((await admin().post('/api/org/branches', { name: 'downtown', city: 'Dubai', counters: 2 })).status, 409);
  // Another organisation may use the same name.
  assert.equal((await as(tokens.oasisAdmin).post('/api/org/branches', { name: 'Downtown', city: 'Sharjah', counters: 1 })).status, 201);

  const edit = await admin().patch(`/api/org/branches/${branchId}`, { counters: 3, city: 'Dubai Creek' });
  assert.equal(edit.body.data.counters, 3);
  assert.equal(edit.body.data.city, 'Dubai Creek');
  assert.equal((await admin().post('/api/org/branches', { name: '', city: 'x', counters: 0 })).status, 400);
});

let pharmacist;
test('add a pharmacist: temporary password, must change it at first sign-in', async () => {
  const res = await admin().post('/api/org/users', {
    fullName: 'Nour Test', email: 'Nour@Test.example', role: 'pharmacist', branchId, counterNo: 1,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  pharmacist = res.body.data.user;
  const temp = res.body.data.temporaryPassword;
  assert.equal(pharmacist.email, 'nour@test.example', 'emails are stored in lower case');
  assert.match(temp, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

  const signIn = await login('nour@test.example', temp);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.body.data.user.mustChangePassword, true);
  const t = signIn.body.data.token;
  // Nothing else works until the password is changed.
  const blocked = await as(t).get('/api/queue/current');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await as(t).get('/api/auth/me')).status, 200);

  assert.equal((await as(t).post('/api/auth/password', { currentPassword: temp, newPassword: 'short' })).status, 400);
  assert.equal((await as(t).post('/api/auth/password', { currentPassword: 'wrong-one-1', newPassword: 'Counter1Strong' })).status, 400);
  const changed = await as(t).post('/api/auth/password', { currentPassword: temp, newPassword: 'Counter1Strong' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const fresh = changed.body.data.token;
  assert.equal((await as(fresh).get('/api/queue/current')).status, 200, 'new session works');
  assert.equal((await as(t).get('/api/auth/me')).status, 401, 'the old session is signed out');
  assert.equal((await login('nour@test.example', 'Counter1Strong')).status, 200);
});

test('counters: one pharmacist per counter, within the branch’s counters', async () => {
  const clash = await admin().post('/api/org/users', { fullName: 'B', email: 'b@test.example', role: 'pharmacist', branchId, counterNo: 1 });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error.message, /already assigned to Nour Test/);
  const tooHigh = await admin().post('/api/org/users', { fullName: 'B', email: 'b@test.example', role: 'pharmacist', branchId, counterNo: 9 });
  assert.equal(tooHigh.status, 400);
  const noBranch = await admin().post('/api/org/users', { fullName: 'B', email: 'b@test.example', role: 'manager' });
  assert.equal(noBranch.status, 400);
  const dup = await admin().post('/api/org/users', { fullName: 'B', email: 'admin@demo.falconmed.app', role: 'admin' });
  assert.equal(dup.status, 409, 'emails are unique across the platform');

  // Cannot shrink a branch below an occupied counter.
  await admin().patch(`/api/org/users/${pharmacist.id}`, { counterNo: 3 });
  const shrink = await admin().patch(`/api/org/branches/${branchId}`, { counters: 2 });
  assert.equal(shrink.status, 409);
  assert.match(shrink.body.error.message, /counter 3/);
});

test('cannot place staff in another organisation’s branch', async () => {
  const res = await admin().post('/api/org/users', { fullName: 'X', email: 'x@test.example', role: 'manager', branchId: 'br_ad01' });
  assert.equal(res.status, 404);
  assert.equal((await admin().patch('/api/org/branches/br_ad01', { name: 'Hijack' })).status, 404);
  assert.equal((await admin().patch('/api/org/users/u_admin', { isActive: false })).status, 404);
  const team = (await admin().get('/api/org/users')).body.data;
  assert.ok(team.every((u) => u.email.endsWith('test.example')));
});

test('promote, move and deactivate a team member', async () => {
  const mgr = await admin().patch(`/api/org/users/${pharmacist.id}`, { role: 'manager' });
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.data.counterNo, null, 'managers have no counter');
  const back = await admin().patch(`/api/org/users/${pharmacist.id}`, { role: 'pharmacist' });
  assert.equal(back.status, 400, 'a pharmacist needs a counter');
  await admin().patch(`/api/org/users/${pharmacist.id}`, { role: 'pharmacist', counterNo: 2 });

  // A branch with active staff cannot be deactivated.
  assert.equal((await admin().patch(`/api/org/branches/${branchId}`, { isActive: false })).status, 409);

  const off = await admin().patch(`/api/org/users/${pharmacist.id}`, { isActive: false });
  assert.equal(off.body.data.isActive, false);
  assert.equal((await login('nour@test.example', 'Counter1Strong')).status, 401, 'deactivated accounts cannot sign in');
  assert.equal((await admin().patch(`/api/org/branches/${branchId}`, { isActive: false })).status, 200);
  // Reactivating into an inactive branch is refused until the branch is back.
  assert.equal((await admin().patch(`/api/org/users/${pharmacist.id}`, { isActive: true })).status, 400);
  await admin().patch(`/api/org/branches/${branchId}`, { isActive: true });
  assert.equal((await admin().patch(`/api/org/users/${pharmacist.id}`, { isActive: true })).status, 200);
});

test('a pharmacist serving a patient cannot be moved until the ticket is closed', async () => {
  const t = (await login('nour@test.example', 'Counter1Strong')).body.data.token;
  const key = (await admin().post('/api/org/api-keys', { name: 'Kiosk' })).body.data.secret;
  assert.equal((await request(app).post('/api/queue/tickets').set('X-Queue-Key', key).send({ branchId })).status, 201);
  const called = await as(t).post('/api/queue/call-next');
  assert.ok(called.body.data);
  const move = await admin().patch(`/api/org/users/${pharmacist.id}`, { counterNo: 3 });
  assert.equal(move.status, 409);
  await as(t).post(`/api/queue/tickets/${called.body.data.id}/complete`, { outcome: 'served' });
  assert.equal((await admin().patch(`/api/org/users/${pharmacist.id}`, { counterNo: 3 })).status, 200);
});

test('an admin can reset a password; old sessions end and a new password is required', async () => {
  const before = (await login('nour@test.example', 'Counter1Strong')).body.data.token;
  const res = await admin().post(`/api/org/users/${pharmacist.id}/reset-password`);
  assert.equal(res.status, 200);
  assert.equal((await as(before).get('/api/auth/me')).status, 401);
  assert.equal((await login('nour@test.example', 'Counter1Strong')).status, 401);
  const signIn = await login('nour@test.example', res.body.data.temporaryPassword);
  assert.equal(signIn.body.data.user.mustChangePassword, true);
  assert.equal((await admin().post('/api/org/users/u_test_admin/reset-password')).status, 400, 'not your own');
});

test('an organisation always keeps one active admin, and admins cannot lock themselves out', async () => {
  assert.equal((await admin().patch('/api/org/users/u_test_admin', { isActive: false })).status, 400);
  assert.equal((await admin().patch('/api/org/users/u_test_admin', { role: 'manager', branchId })).status, 400);
  const second = await admin().post('/api/org/users', { fullName: 'Second Admin', email: 'second@test.example', role: 'admin' });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.user.branchId, null);
  // Self-protection still applies even with another admin.
  assert.equal((await admin().patch('/api/org/users/u_test_admin', { isActive: false })).status, 400);
  // The other admin can be deactivated now that one remains.
  assert.equal((await admin().patch(`/api/org/users/${second.body.data.user.id}`, { isActive: false })).status, 200);
});

test('demo records are protected so the public demo keeps working', async () => {
  const d = as(tokens.demoAdmin);
  assert.equal((await d.get('/api/org')).body.data.demoProtected, true);
  assert.equal((await d.patch('/api/org', { name: 'Hacked' })).status, 403);
  assert.equal((await d.patch('/api/org/branches/br_ad01', { name: 'Hacked' })).status, 403);
  assert.equal((await d.patch('/api/org/users/u_mg_ad01', { isActive: false })).status, 403);
  assert.equal((await d.post('/api/org/users/u_ph_ad01_1/reset-password')).status, 403);
  assert.equal((await d.post('/api/auth/password', { currentPassword: env.DEMO_PASSWORD, newPassword: 'Changed1234' })).status, 403);
  assert.equal((await login('manager@demo.falconmed.app')).status, 200, 'demo sign-in still works');

  // Visitors can still try everything on records they create themselves.
  const b = await d.post('/api/org/branches', { name: 'Visitor Branch', city: 'Abu Dhabi', counters: 2 });
  assert.equal(b.status, 201);
  assert.equal(b.body.data.demoProtected, false);
  assert.equal((await d.patch(`/api/org/branches/${b.body.data.id}`, { counters: 3 })).status, 200);
  const u = await d.post('/api/org/users', { fullName: 'Visitor', email: 'visitor@example.com', role: 'manager', branchId: b.body.data.id });
  assert.equal(u.status, 201);
  assert.equal((await d.patch(`/api/org/users/${u.body.data.user.id}`, { fullName: 'Visitor Two' })).status, 200);

  // The next demo refresh removes visitor additions.
  await seed({ days: 1, reset: true, log: () => {} });
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE email = 'visitor@example.com'`);
  assert.equal(rows[0].n, 0);
  const kept = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE org_id = 'org_test'`);
  assert.ok(kept.rows[0].n >= 2, 'real organisations untouched');
});
