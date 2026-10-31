/**
 * Importer tests — run against a real PostgreSQL (see api.test.js header).
 * Uses the sample files shipped in frontend/public/samples.
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
import { parseDateTime } from '../src/services/importer.js';

const app = createApp();
const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/public/samples');
const sample = (f) => readFileSync(path.join(SAMPLES, f), 'utf8');
const tokens = {};

const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: env.DEMO_PASSWORD })).body.data.token;
const post = (role, url, body) => request(app).post(url).set('Authorization', `Bearer ${tokens[role]}`).send(body);
const get = (role, url) => request(app).get(url).set('Authorization', `Bearer ${tokens[role]}`);
const del = (role, url) => request(app).delete(url).set('Authorization', `Bearer ${tokens[role]}`);
const issue = (report, code) => report.issues.find((i) => i.code === code);

before(async () => {
  await seed({ days: 3, reset: true, log: () => {} });
  tokens.admin = await login('admin@demo.falconmed.app');
  tokens.manager = await login('manager@demo.falconmed.app');
  tokens.pharmacist = await login('pharmacist@demo.falconmed.app');
});
after(() => pool.end());

test('only admins and managers can use the importer', async () => {
  const res = await post('pharmacist', '/api/imports/validate', { csv: 'a\n1' });
  assert.equal(res.status, 403);
  assert.equal((await request(app).post('/api/imports/validate').send({ csv: 'a' })).status, 401);
});

test('template validates at 100 %', async () => {
  const res = await post('admin', '/api/imports/validate', { csv: sample('falconmed-import-template.csv') });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.summary.score, 100);
  assert.equal(res.body.data.summary.valid, 3);
});

test('clean week: every row valid, KPIs previewed, nothing written yet', async () => {
  const res = await post('admin', '/api/imports/validate', { csv: sample('sample-clean-week.csv'), fileName: 'clean.csv' });
  const r = res.body.data;
  assert.equal(r.summary.rejected, 0);
  assert.equal(r.summary.grade, 'excellent');
  assert.equal(r.summary.days, 7);
  assert.ok(r.preview.serveRate > 95);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets WHERE branch_id = 'br_lab'`);
  assert.equal(rows[0].n, 0, 'validate must not write');
});

test('messy export: foreign column names, DD/MM dates, 12-hour times and every defect type are handled', async () => {
  const r = (await post('admin', '/api/imports/validate', { csv: sample('sample-messy-export.csv') })).body.data;
  assert.equal(r.file.dateOrder, 'DD/MM/YYYY');
  assert.equal(r.file.timePrecision, 'minutes');
  assert.equal(r.file.columns.arrived_at, 'Issue Time');
  assert.equal(r.file.columns.ticket_no, 'Token No');
  for (const code of ['called_before_arrival', 'finished_before_called', 'missing_arrival', 'bad_service', 'duplicate_in_file']) {
    assert.ok(issue(r, code)?.severity === 'error', `expected error ${code}`);
  }
  for (const code of ['never_closed', 'left_unseen', 'long_wait', 'odd_hour', 'emirates_id']) {
    assert.ok(issue(r, code)?.severity === 'warning', `expected warning ${code}`);
  }
  assert.ok(!issue(r, 'instant_service'), 'minute-precision files must not raise instant-service noise');
  assert.ok(r.summary.score > 90 && r.summary.score < 100);
});

test('privacy: patient-identifier columns are dropped and Emirates IDs never stored', async () => {
  const csv = [
    'arrived_at,called_at,finished_at,Patient Name,Mobile,Emirates ID,patient_ref',
    '2026-10-05 09:00,2026-10-05 09:02,2026-10-05 09:05,Test Person,0500000000,784-1990-1234567-1,784-1990-1234567-1',
  ].join('\n');
  const r = (await post('admin', '/api/imports/validate', { csv, defaultBranchId: 'br_lab' })).body.data;
  assert.deepEqual(r.file.ignoredSensitive, ['Patient Name', 'Mobile', 'Emirates ID']);
  assert.ok(issue(r, 'emirates_id'));
  assert.ok(issue(r, 'bad_patient_ref'), 'an Emirates ID in patient_ref is refused');
  const imp = await post('admin', '/api/imports', { csv, defaultBranchId: 'br_lab', fileName: 'privacy.csv' });
  assert.equal(imp.status, 201);
  const { rows } = await pool.query(
    `SELECT patient_ref FROM falconmed_v4.tickets WHERE import_batch_id = $1`,
    [imp.body.data.batchId],
  );
  assert.equal(rows[0].patient_ref, null);
  await del('admin', `/api/imports/${imp.body.data.batchId}`);
});

test('import → dashboard reflects it → re-import is rejected as duplicate → rollback removes it', async () => {
  const csv = sample('sample-clean-week.csv');
  const imp = await post('admin', '/api/imports', { csv, fileName: 'clean-week.csv' });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  const { batchId } = imp.body.data;

  const kpi = await get('admin', '/api/metrics/summary?branchId=br_lab&from=2026-10-18&to=2026-10-24');
  assert.equal(kpi.body.data.current.totalTickets, 2441);
  assert.equal(kpi.body.data.current.serveRate, imp.body.data.report.preview.serveRate, 'preview uses the same KPI definitions');
  assert.equal(kpi.body.data.current.avgWaitMin, imp.body.data.report.preview.avgWaitMin);

  const again = await post('admin', '/api/imports/validate', { csv });
  assert.equal(again.body.data.summary.valid, 0);
  assert.equal(issue(again.body.data, 'duplicate_in_db').count, 2441);

  const hist = await get('admin', '/api/imports');
  assert.ok(hist.body.data.some((b) => b.id === batchId && b.rowsImported === 2441));

  const rb = await del('admin', `/api/imports/${batchId}`);
  assert.equal(rb.body.data.rowsRemoved, 2441);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets WHERE import_batch_id = $1`, [batchId]);
  assert.equal(rows[0].n, 0);
});

test('managers can import only into their own branch', async () => {
  const csv = sample('falconmed-import-template.csv'); // rows say br_lab
  const r = (await post('manager', '/api/imports/validate', { csv })).body.data;
  assert.equal(r.summary.valid, 0);
  assert.equal(issue(r, 'branch_not_allowed').count, 3);
  const own = csv.replaceAll('br_lab', 'br_ad01').replace(/2026-10-04/g, '2026-09-01');
  const ok = (await post('manager', '/api/imports/validate', { csv: own })).body.data;
  assert.equal(ok.summary.valid, 3);
});

test('dates: ISO, DD/MM, MM/DD (auto-detected), 12-hour, Excel serial and time-only with a date column', () => {
  const tz = 'Asia/Dubai';
  const iso = (d) => d.toISOString();
  assert.equal(iso(parseDateTime('2026-10-05 09:30', { tz })), '2026-10-05T05:30:00.000Z');
  assert.equal(iso(parseDateTime('05/10/2026 09:30 PM', { tz, dayFirst: true })), '2026-10-05T17:30:00.000Z');
  assert.equal(iso(parseDateTime('10/05/2026 09:30', { tz, dayFirst: false })), '2026-10-05T05:30:00.000Z');
  assert.equal(iso(parseDateTime('2026-10-05T09:30:00Z', { tz })), '2026-10-05T09:30:00.000Z');
  assert.equal(iso(parseDateTime('46300.5', { tz })), '2026-10-05T08:00:00.000Z');
  assert.equal(iso(parseDateTime('09:30', { tz, dateOnly: '2026-10-05' })), '2026-10-05T05:30:00.000Z');
  assert.equal(parseDateTime('31/02/2026 10:00', { tz }), 'invalid');
  assert.equal(parseDateTime('tomorrow', { tz }), 'invalid');
  assert.equal(parseDateTime('', { tz }), null);
});

test('hostile content is treated as data, never executed', async () => {
  const csv = [
    'ticket_no,branch,arrived_at,called_at,finished_at,service_type',
    `"X-1'); DROP TABLE falconmed_v4.tickets;--",br_lab,2026-10-06 10:00,2026-10-06 10:01,2026-10-06 10:04,prescription`,
  ].join('\n');
  const imp = await post('admin', '/api/imports', { csv, fileName: '<script>.csv' });
  assert.equal(imp.status, 201);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM falconmed_v4.tickets');
  assert.ok(rows[0].n > 0);
  await del('admin', `/api/imports/${imp.body.data.batchId}`);
});

test('unreadable or empty files get a clear message', async () => {
  assert.equal((await post('admin', '/api/imports/validate', { csv: ' ' })).status, 400);
  const noArrival = await post('admin', '/api/imports/validate', { csv: 'foo,bar\n1,2' });
  assert.equal(noArrival.status, 400);
  assert.match(noArrival.body.error.message, /arrival/i);
});

test('stress: 50,000 rows validate and import within limits', async () => {
  const lines = sample('sample-clean-week.csv').trim().split(/\r?\n/);
  const header = lines[0];
  const body = lines.slice(1);
  const out = [header];
  for (let i = 0; out.length <= 50_000; i++) {
    const cols = body[i % body.length].split(',');
    cols[0] = `S${i}`;
    out.push(cols.join(','));
  }
  const csv = out.join('\n');
  const t0 = Date.now();
  const imp = await post('admin', '/api/imports', { csv, fileName: 'stress.csv' });
  const ms = Date.now() - t0;
  assert.equal(imp.status, 201, JSON.stringify(imp.body).slice(0, 300));
  assert.equal(imp.body.data.report.summary.valid, 50_000);
  assert.ok(ms < 30_000, `took ${ms} ms`);
  console.log(`# stress import: 50,000 rows in ${ms} ms`);
  await del('admin', `/api/imports/${imp.body.data.batchId}`);
});
