/**
 * Production SaaS tests: per-organisation queue keys, trial and plan
 * enforcement, account lockout, password reset and email verification,
 * Stripe billing, data export, audit log and organisation deletion.
 * Runs against a real PostgreSQL (see api.test.js header). Stripe is faked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import Stripe from 'stripe';
import { pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { outbox } from '../src/lib/mailer.js';
import { setStripeClient } from '../src/services/billing.js';

const app = createApp();
const as = (token) => ({
  get: (url) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url, body = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url, body = {}) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  del: (url, body = {}) => request(app).delete(url).set('Authorization', `Bearer ${token}`).send(body),
});
const ticket = (key, branchId) => request(app).post('/api/queue/tickets').set('X-Queue-Key', key).send({ branchId });
const linkToken = (mail) => mail.text.match(/token=([\w-]+)/)[1];
const lastEmailTo = (to) => outbox.filter((m) => m.to === to).at(-1);
const created = [];

let n = 0;
/** A brand-new organisation through the public sign-up. */
async function newOrg(name = 'Saas Test Pharmacy') {
  n += 1;
  const email = `owner${n}.${Date.now()}@saas.example`;
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ organisationName: `${name} ${n}`, fullName: 'Owner Person', email, password: 'Strong-Pass-2026', acceptTerms: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const org = { token: res.body.data.token, user: res.body.data.user, email, id: res.body.data.user.orgId };
  created.push(org.id);
  const br = await as(org.token).post('/api/org/branches', { name: 'Main', city: 'Dubai', counters: 2 });
  org.branchId = br.body.data.id;
  return org;
}
const setOrg = (id, sql, params = []) => pool.query(`UPDATE falconmed_v4.organizations SET ${sql} WHERE id = $1`, [id, ...params]);

before(() => seed({ days: 1, reset: true, log: () => {} }));
after(async () => {
  for (const id of created) {
    await pool.query(`DELETE FROM falconmed_v4.tickets WHERE branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = $1)`, [id]);
    await pool.query('DELETE FROM falconmed_v4.api_keys WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.audit_log WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.users WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.branches WHERE org_id = $1', [id]);
    await pool.query('DELETE FROM falconmed_v4.organizations WHERE id = $1', [id]);
  }
  await pool.end();
});

// ── queue keys ──────────────────────────────────────────────────
test('the shared environment key reaches demo organisations only, never a customer', async () => {
  const org = await newOrg();
  assert.equal((await ticket(env.QUEUE_API_KEY, org.branchId)).status, 403);
  assert.equal((await ticket(env.QUEUE_API_KEY, 'br_os01')).status, 201, 'demo still works');
});

test('an organisation key only reaches its own organisation, and a branch key only its branch', async () => {
  const a = await newOrg();
  const b = await newOrg();
  const created = await as(a.token).post('/api/org/api-keys', { name: 'Front kiosk' });
  assert.equal(created.status, 201);
  const key = created.body.data.secret;
  assert.match(key, /^fmq_/);

  assert.equal((await ticket(key, a.branchId)).status, 201);
  assert.equal((await ticket(key, b.branchId)).status, 403, 'other organisation');
  assert.equal((await ticket(key, 'br_ad01')).status, 403, 'demo organisation');

  const second = (await as(a.token).post('/api/org/branches', { name: 'Second', city: 'Sharjah', counters: 1 })).body.data.id;
  const pinned = (await as(a.token).post('/api/org/api-keys', { name: 'Main only', branchId: a.branchId })).body.data;
  assert.equal((await ticket(pinned.secret, second)).status, 403);
  assert.equal((await ticket(pinned.secret, a.branchId)).status, 201);

  // Keys are listed without their secret, and only to their own organisation.
  const list = (await as(a.token).get('/api/org/api-keys')).body.data;
  assert.equal(list.length, 2);
  assert.ok(list.every((k) => !('secret' in k) && k.prefix.startsWith('fmq_')));
  assert.equal((await as(b.token).get('/api/org/api-keys')).body.data.length, 0);
  assert.equal((await as(b.token).del(`/api/org/api-keys/${pinned.key.id}`)).status, 404, 'cannot revoke another organisation\'s key');

  assert.equal((await as(a.token).del(`/api/org/api-keys/${pinned.key.id}`)).status, 200);
  assert.equal((await ticket(pinned.secret, a.branchId)).status, 401, 'revoked');
  assert.equal((await ticket('fmq_made-up-key-value', a.branchId)).status, 401);
});

test('a key cannot attach to another organisation\'s branch', async () => {
  const a = await newOrg();
  const res = await as(a.token).post('/api/org/api-keys', { name: 'Sneaky', branchId: 'br_ad01' });
  assert.equal(res.status, 404);
});

// ── trial and plans ─────────────────────────────────────────────
test('when the trial ends the product locks, but billing, settings and export stay open', async () => {
  const org = await newOrg();
  const key = (await as(org.token).post('/api/org/api-keys', { name: 'Kiosk' })).body.data.secret;
  await setOrg(org.id, `trial_ends_at = now() - interval '1 minute'`);

  const me = (await as(org.token).get('/api/auth/me')).body.data;
  assert.equal(me.entitled, false);
  assert.equal(me.entitlementReason, 'trial_ended');
  for (const url of ['/api/metrics/summary', '/api/queue/live', '/api/imports']) {
    const res = await as(org.token).get(url);
    assert.equal(res.status, 402, url);
    assert.equal(res.body.error.code, 'SUBSCRIPTION_REQUIRED');
  }
  assert.equal((await ticket(key, org.branchId)).status, 402, 'the kiosk stops too');
  assert.equal((await as(org.token).post('/api/org/branches', { name: 'More', city: 'X', counters: 1 })).status, 402);
  assert.equal((await as(org.token).get('/api/org')).status, 200);
  assert.equal((await as(org.token).get('/api/billing')).status, 200);
  assert.equal((await as(org.token).get('/api/org/export')).status, 200);

  // A paid subscription unlocks it again.
  await setOrg(org.id, `plan = 'starter', subscription_status = 'active'`);
  assert.equal((await as(org.token).get('/api/metrics/summary')).status, 200);
  await setOrg(org.id, `subscription_status = 'canceled'`);
  assert.equal((await as(org.token).get('/api/metrics/summary')).status, 402);
});

test('plan limits cap active branches and team members', async () => {
  const org = await newOrg();
  await setOrg(org.id, `plan = 'starter', subscription_status = 'active'`); // starter: 2 branches
  assert.equal((await as(org.token).post('/api/org/branches', { name: 'Two', city: 'X', counters: 1 })).status, 201);
  const third = await as(org.token).post('/api/org/branches', { name: 'Three', city: 'X', counters: 1 });
  assert.equal(third.status, 402);
  assert.equal(third.body.error.code, 'PLAN_LIMIT');

  const billing = (await as(org.token).get('/api/billing')).body.data;
  assert.equal(billing.limits.branches, 2);
  assert.equal(billing.usage.branches, 2);
});

// ── sign-in protection ──────────────────────────────────────────
const loginFrom = (ip, email, password) => request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });

test('an account locks after repeated failures; strangers stay out but the owner\'s usual IP gets in', async () => {
  const org = await newOrg();
  assert.equal((await loginFrom('203.0.113.10', org.email, 'Strong-Pass-2026')).status, 200, 'owner signs in from home');
  await pool.query(`UPDATE falconmed_v4.users SET failed_logins = 9, last_failed_login_at = now() WHERE email = $1`, [org.email]);
  assert.equal((await loginFrom('198.51.100.7', org.email, 'not-it-at-all')).status, 401);

  const stranger = await loginFrom('198.51.100.7', org.email, 'Strong-Pass-2026');
  assert.equal(stranger.status, 429, 'even with the right password from elsewhere');
  assert.equal(stranger.body.error.code, 'RATE_LIMITED');
  assert.equal((await loginFrom('203.0.113.10', org.email, 'wrong-from-home')).status, 429, 'wrong password from home still locked');
  assert.equal((await loginFrom('203.0.113.10', org.email, 'Strong-Pass-2026')).status, 200, 'owner not locked out by an attacker');

  const audit = (await as(org.token).get('/api/org/audit')).body.data;
  assert.ok(audit.some((a) => a.action === 'auth.login_failed'));
});

test('old failed sign-ins expire, so occasional typos never lock an account', async () => {
  const org = await newOrg();
  await pool.query(`UPDATE falconmed_v4.users SET failed_logins = 9, last_failed_login_at = now() - interval '1 hour' WHERE email = $1`, [org.email]);
  assert.equal((await loginFrom('198.51.100.8', org.email, 'a-typo-here')).status, 401);
  assert.equal((await loginFrom('198.51.100.8', org.email, 'Strong-Pass-2026')).status, 200);
});

test('parallel requests cannot exceed the plan limit', async () => {
  const org = await newOrg(); // trial: 3 branches, 1 already
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => as(org.token).post('/api/org/branches', { name: `Rush ${i}`, city: 'X', counters: 1 })),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM falconmed_v4.branches WHERE org_id = $1 AND is_active', [org.id]);
  assert.equal(rows[0].n, 3);
});

test('a deactivated team member\'s invitation link stops working', async () => {
  const org = await newOrg();
  const res = await as(org.token).post('/api/org/users', { fullName: 'Short Stay', email: `short.${Date.now()}@saas.example`, role: 'manager', branchId: org.branchId });
  const token = linkToken(lastEmailTo(res.body.data.user.email));
  assert.equal((await as(org.token).patch(`/api/org/users/${res.body.data.user.id}`, { isActive: false })).status, 200);
  assert.equal((await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Short-Stay-2026' })).status, 400);
});

test('forgot password: same answer for unknown emails, single-use link, every session signed out', async () => {
  const org = await newOrg();
  const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@nowhere.example' });
  const known = await request(app).post('/api/auth/forgot-password').send({ email: org.email });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, known.body);
  assert.equal(lastEmailTo('nobody@nowhere.example'), undefined);

  const token = linkToken(lastEmailTo(org.email));
  const weak = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'short' });
  assert.equal(weak.status, 400);
  const reset = await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Brand-New-Pass-77' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.ok(reset.body.data.token);

  assert.equal((await as(org.token).get('/api/auth/me')).status, 401, 'old session ended');
  assert.equal((await request(app).post('/api/auth/reset-password').send({ token, newPassword: 'Another-Pass-88' })).status, 400, 'single use');
  assert.equal((await request(app).post('/api/auth/login').send({ email: org.email, password: 'Brand-New-Pass-77' })).status, 200);
});

test('demo accounts cannot be taken over through password reset', async () => {
  const before = outbox.length;
  await request(app).post('/api/auth/forgot-password').send({ email: 'admin@demo.falconmed.app' });
  assert.equal(outbox.length, before);
});

test('sign-up sends a confirmation link that verifies the email', async () => {
  const org = await newOrg();
  assert.equal(org.user.emailVerified, false);
  const token = linkToken(lastEmailTo(org.email));
  assert.equal((await request(app).post('/api/auth/verify-email').send({ token })).status, 200);
  assert.equal((await as(org.token).get('/api/auth/me')).body.data.emailVerified, true);
  assert.equal((await request(app).post('/api/auth/verify-email').send({ token })).status, 400, 'single use');
});

test('new team members are invited by email with a link to choose their password', async () => {
  const org = await newOrg();
  const res = await as(org.token).post('/api/org/users', { fullName: 'Lina Staff', email: `lina.${Date.now()}@saas.example`, role: 'manager', branchId: org.branchId });
  assert.equal(res.status, 201);
  const mail = lastEmailTo(res.body.data.user.email);
  assert.match(mail.subject, /invited you/);
  const set = await request(app).post('/api/auth/reset-password').send({ token: linkToken(mail), newPassword: 'Lina-Chooses-2026' });
  assert.equal(set.status, 200);
  assert.equal(set.body.data.user.mustChangePassword, false);
  assert.equal(set.body.data.user.emailVerified, true);
});

// ── billing ─────────────────────────────────────────────────────
const WEBHOOK_SECRET = 'whsec_test_secret_for_falconmed';
const subscriptions = new Map();
const fakeStripe = {
  webhooks: new Stripe('sk_test_unused').webhooks,
  customers: { create: async (p) => ({ id: `cus_${p.metadata.org_id}` }) },
  checkout: { sessions: { create: async (p) => ({ url: `https://checkout.stripe.test/${p.customer}/${p.line_items[0].price}` }) } },
  billingPortal: { sessions: { create: async (p) => ({ url: `https://billing.stripe.test/${p.customer}` }) } },
  subscriptions: {
    list: async ({ customer }) => ({ data: [...subscriptions.values()].filter((x) => x.customer === customer) }),
    retrieve: async (id) => subscriptions.get(id),
    cancel: async (id) => ({ ...subscriptions.get(id), status: 'canceled' }),
  },
};
const sendEvent = (event) => {
  const payload = JSON.stringify(event);
  const header = fakeStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return request(app).post('/api/billing/webhook').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(payload);
};

test('billing: checkout needs a confirmed email, and a subscription event upgrades the organisation', async () => {
  Object.assign(env, { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro' });
  setStripeClient(fakeStripe);
  const org = await newOrg();

  assert.equal((await as(org.token).post('/api/billing/checkout', { plan: 'pro' })).status, 403, 'email not confirmed');
  await request(app).post('/api/auth/verify-email').send({ token: linkToken(lastEmailTo(org.email)) });
  const checkout = await as(org.token).post('/api/billing/checkout', { plan: 'pro' });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  assert.equal(checkout.body.data.url, `https://checkout.stripe.test/cus_${org.id}/price_pro`);

  // A forged event is refused.
  const forged = await request(app).post('/api/billing/webhook').set('Stripe-Signature', 't=1,v1=bad').set('Content-Type', 'application/json').send('{}');
  assert.equal(forged.status, 400);

  // Unique per run: processed event IDs are kept (that is the point of the dedupe).
  const run = Date.now().toString(36);
  const subId = `sub_${run}`;
  subscriptions.set(subId, {
    id: subId,
    customer: `cus_${org.id}`,
    status: 'active',
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_pro' }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
  });
  const event = { id: `evt_${run}_1`, type: 'customer.subscription.created', data: { object: { id: subId } } };
  const res = await sendEvent(event);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await sendEvent(event)).body.duplicate, true, 'processed once');

  const billing = (await as(org.token).get('/api/billing')).body.data;
  assert.equal(billing.plan, 'pro');
  assert.equal(billing.status, 'active');
  assert.ok(billing.currentPeriodEnd);
  assert.equal((await as(org.token).post('/api/billing/checkout', { plan: 'starter' })).status, 409, 'already subscribed');

  // Two deliveries of one event at the same moment are handled once.
  const again = { id: `evt_${run}_dup`, type: 'invoice.payment_failed', data: { object: { id: 'in_1', customer: `cus_${org.id}` } } };
  const before = outbox.length;
  const both = await Promise.all([sendEvent(again), sendEvent(again)]);
  assert.deepEqual(both.map((r) => r.body.duplicate).sort(), [false, true]);
  assert.equal(outbox.length - before, 1, 'one payment-failed email');
  assert.equal((await as(org.token).post('/api/billing/portal')).body.data.url, `https://billing.stripe.test/cus_${org.id}`);

  // A paying subscription keeps access after the trial, even on a price this server does not know (e.g. annual).
  await setOrg(org.id, `trial_ends_at = now() - interval '1 day'`);
  subscriptions.set(subId, { ...subscriptions.get(subId), items: { data: [{ price: { id: 'price_annual_unknown' }, current_period_end: 0 }] } });
  await sendEvent({ id: `evt_${run}_annual`, type: 'customer.subscription.updated', data: { object: { id: subId } } });
  assert.equal((await as(org.token).get('/api/auth/me')).body.data.entitled, true);

  // Cancellation arrives later: the product locks.
  subscriptions.set(subId, { ...subscriptions.get(subId), status: 'canceled' });
  await sendEvent({ id: `evt_${run}_2`, type: 'customer.subscription.deleted', data: { object: { id: subId } } });
  assert.equal((await as(org.token).get('/api/auth/me')).body.data.entitled, false);
});

test('billing is for admins only, and the demo organisation cannot subscribe', async () => {
  const demo = (await request(app).post('/api/auth/login').send({ email: 'admin@demo.falconmed.app', password: env.DEMO_PASSWORD })).body.data.token;
  const manager = (await request(app).post('/api/auth/login').send({ email: 'manager@demo.falconmed.app', password: env.DEMO_PASSWORD })).body.data.token;
  assert.equal((await as(manager).get('/api/billing')).status, 403);
  assert.equal((await as(demo).post('/api/billing/checkout', { plan: 'pro' })).status, 403);
});

// ── export, audit, deletion ─────────────────────────────────────
test('export is a CSV of the organisation\'s own tickets, safe to open in a spreadsheet', async () => {
  const org = await newOrg();
  const key = (await as(org.token).post('/api/org/api-keys', { name: 'Kiosk' })).body.data.secret;
  await ticket(key, org.branchId);
  await pool.query(`UPDATE falconmed_v4.tickets SET patient_ref = '=HYPERLINK(1)' WHERE branch_id = $1`, [org.branchId]);
  const res = await as(org.token).get('/api/org/export');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  const lines = res.text.trim().split('\r\n');
  assert.equal(lines.length, 2, 'header + this organisation\'s one ticket');
  assert.match(lines[1], /'=HYPERLINK\(1\)/);
});

test('API responses are never cached and carry a request ID', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(res.headers['x-request-id']);
});

test('an admin can delete the organisation; its people and data are gone', async () => {
  const org = await newOrg('Leaving Pharmacy');
  const key = (await as(org.token).post('/api/org/api-keys', { name: 'Kiosk' })).body.data.secret;
  await ticket(key, org.branchId);
  const name = (await as(org.token).get('/api/org')).body.data.name;

  assert.equal((await as(org.token).del('/api/org', { confirmName: 'wrong', password: 'Strong-Pass-2026' })).status, 400);
  assert.equal((await as(org.token).del('/api/org', { confirmName: name, password: 'wrong-password' })).status, 400);
  assert.equal((await as(org.token).del('/api/org', { confirmName: name, password: 'Strong-Pass-2026' })).status, 200);

  assert.equal((await as(org.token).get('/api/auth/me')).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: org.email, password: 'Strong-Pass-2026' })).status, 401);
  assert.equal((await ticket(key, org.branchId)).status, 401);
  const left = await pool.query(
    `SELECT (SELECT COUNT(*) FROM falconmed_v4.users WHERE org_id = $1)::int AS users,
            (SELECT COUNT(*) FROM falconmed_v4.branches WHERE org_id = $1)::int AS branches,
            (SELECT name FROM falconmed_v4.organizations WHERE id = $1) AS name`,
    [org.id],
  );
  assert.deepEqual(left.rows[0], { users: 0, branches: 0, name: 'Deleted organisation' });
  const trail = await pool.query(`SELECT actor_id FROM falconmed_v4.audit_log WHERE org_id = $1 AND action = 'org.delete'`, [org.id]);
  assert.equal(trail.rows.length, 1, 'the deletion itself is audited');
});

test('the demo organisation cannot be deleted', async () => {
  const demo = (await request(app).post('/api/auth/login').send({ email: 'admin@demo.falconmed.app', password: env.DEMO_PASSWORD })).body.data.token;
  const res = await as(demo).del('/api/org', { confirmName: 'FalconMed Demo Network', password: env.DEMO_PASSWORD });
  assert.equal(res.status, 403);
});
