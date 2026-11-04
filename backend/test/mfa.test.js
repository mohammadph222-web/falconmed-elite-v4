/**
 * Two-factor sign-in (authenticator app) and the shared rate-limit store.
 * Runs against a real PostgreSQL (see api.test.js header).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { outbox } from '../src/lib/mailer.js';
import { currentStep, totpAt } from '../src/lib/totp.js';

const app = createApp();
const as = (token) => ({
  get: (url) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url, body = {}) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
});
const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });
const verify = (mfaToken, body) => request(app).post('/api/auth/2fa/verify').send({ mfaToken, ...body });
const PASSWORD = 'Strong-Pass-2026';
const created = [];

async function newOrg() {
  const email = `mfa.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@mfa.example`;
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ organisationName: `MFA Pharmacy ${created.length}`, fullName: 'Mfa Owner', email, password: PASSWORD, acceptTerms: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created.push(res.body.data.user.orgId);
  return { email, token: res.body.data.token, orgId: res.body.data.user.orgId };
}

/** Turn on two-factor sign-in; returns the secret and the recovery codes. */
async function enrol(token) {
  const setup = await as(token).post('/api/auth/2fa/setup');
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const { secret, otpauthUrl } = setup.body.data;
  assert.match(otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await as(token).post('/api/auth/2fa/enable', { code: '000000' })).status, 400);
  const on = await as(token).post('/api/auth/2fa/enable', { code: totpAt(secret, currentStep()) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.data.recoveryCodes.length, 10);
  return { secret, recoveryCodes: on.body.data.recoveryCodes };
}

before(async () => {
  await pool.query('DELETE FROM falconmed_v4.rate_limits'); // rate-limit counters persist in the database
  await seed({ days: 1, reset: true, log: () => {} });
});
after(async () => {
  for (const id of created) {
    await pool.query('DELETE FROM falconmed_v4.audit_log WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.users WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.branches WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.organizations WHERE id = $1', [id]);
  }
  await pool.end();
});

test('with two-factor on, a password alone does not sign in; a code does, once', async () => {
  const org = await newOrg();
  const { secret } = await enrol(org.token);
  assert.equal((await as(org.token).get('/api/auth/me')).body.data.twoFactorEnabled, true);

  const step1 = await login(org.email, PASSWORD);
  assert.equal(step1.status, 200);
  assert.equal(step1.body.data.mfaRequired, true);
  assert.equal(step1.body.data.token, undefined, 'no session yet');

  assert.equal((await verify(step1.body.data.mfaToken, { code: '123456' })).status, 401);
  // The code used to enable it is already spent, so the next step's code is used here.
  const code = totpAt(secret, currentStep() + 1);
  const ok = await verify(step1.body.data.mfaToken, { code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.data.token);

  const again = await login(org.email, PASSWORD);
  assert.equal((await verify(again.body.data.mfaToken, { code })).status, 401, 'a code cannot be replayed');
  assert.equal((await verify('not-a-token-at-all', { code })).status, 401);
});

test('recovery codes sign in once each', async () => {
  const org = await newOrg();
  const { recoveryCodes } = await enrol(org.token);
  const challenge = (await login(org.email, PASSWORD)).body.data.mfaToken;
  assert.equal((await verify(challenge, { recoveryCode: recoveryCodes[0].toUpperCase() })).status, 200);
  const again = (await login(org.email, PASSWORD)).body.data.mfaToken;
  assert.equal((await verify(again, { recoveryCode: recoveryCodes[0] })).status, 401);
  const me = (await as((await verify(again, { recoveryCode: recoveryCodes[1] })).body.data.token).get('/api/auth/me')).body.data;
  assert.equal(me.recoveryCodesLeft, 8);
});

test('a password reset link does not get past two-factor sign-in', async () => {
  const org = await newOrg();
  await enrol(org.token);
  await request(app).post('/api/auth/forgot-password').send({ email: org.email });
  const mail = outbox.filter((m) => m.to === org.email).at(-1);
  const token = mail.text.match(/token=([\w-]+)/)[1];
  const res = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Changed-Pass-2026' });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.mfaRequired, true);
  assert.equal(res.body.data.token, undefined);
});

test('the secret is encrypted at rest, and turning it off needs the password and a code', async () => {
  const org = await newOrg();
  const { secret } = await enrol(org.token);
  const { rows } = await pool.query('SELECT totp_secret_enc FROM falconmed_v4.users WHERE email = $1', [org.email]);
  assert.ok(!rows[0].totp_secret_enc.includes(secret));
  assert.match(rows[0].totp_secret_enc, /^v1\./);

  const code = totpAt(secret, currentStep() + 1);
  assert.equal((await as(org.token).post('/api/auth/2fa/disable', { password: 'wrong-one-123', code })).status, 400);
  assert.equal((await as(org.token).post('/api/auth/2fa/disable', { password: PASSWORD, code })).status, 200);
  assert.ok((await login(org.email, PASSWORD)).body.data.token, 'password alone works again');
});

test('demo accounts cannot turn on two-factor sign-in (they are shared)', async () => {
  const demo = (await login('admin@demo.falconmed.app', env.DEMO_PASSWORD)).body.data.token;
  assert.equal((await as(demo).post('/api/auth/2fa/setup')).status, 403);
});

test('an organisation can require two-factor sign-in for its admins', async () => {
  const org = await newOrg();
  assert.equal((await as(org.token).patch('/api/org', { requireAdmin2fa: true })).status, 400, 'only once you have it yourself');
  await enrol(org.token);
  assert.equal((await as(org.token).patch('/api/org', { requireAdmin2fa: true })).status, 200);

  // A second admin without it is held at set-up until they turn it on.
  const second = await as(org.token).post('/api/org/users', { fullName: 'Second Admin', email: `second.${Date.now()}@mfa.example`, role: 'admin' });
  const temp = second.body.data.temporaryPassword;
  const t1 = (await login(second.body.data.user.email, temp)).body.data.token;
  const t2 = (await as(t1).post('/api/auth/password', { currentPassword: temp, newPassword: 'Second-Admin-2026' })).body.data.token;
  assert.equal((await as(t2).get('/api/auth/me')).body.data.twoFactorSetupRequired, true);
  const blocked = await as(t2).get('/api/org');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'MFA_SETUP_REQUIRED');
  await enrol(t2);
  assert.equal((await as(t2).get('/api/org')).status, 200);

  // The first admin can reset it for them (lost phone); that also signs them out.
  assert.equal((await as(org.token).post(`/api/org/users/${second.body.data.user.id}/reset-2fa`)).status, 200);
  assert.equal((await as(t2).get('/api/auth/me')).status, 401);
});

test('sign-in rate limits are kept in the database, shared by every server instance', async () => {
  await login('nobody-here@mfa.example', 'wrong-password-1');
  const { rows } = await pool.query(`SELECT key, hits FROM falconmed_v4.rate_limits WHERE key LIKE 'login-email:%nobody-here@mfa.example'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hits, 1);
});
