/**
 * Organisation settings — for organisation admins only.
 * Everything here is limited to the admin's own organisation.
 *
 *   GET    /api/org                         organisation + counts
 *   PATCH  /api/org                         { name }
 *   GET    /api/org/branches                all branches, including inactive
 *   POST   /api/org/branches                { name, city, counters }
 *   PATCH  /api/org/branches/:id            { name?, city?, counters?, isActive? }
 *   GET    /api/org/users                   the whole team, including inactive
 *   POST   /api/org/users                   { fullName, email, role, branchId?, counterNo? } → temporary password
 *   PATCH  /api/org/users/:id               { fullName?, role?, branchId?, counterNo?, isActive? }
 *   POST   /api/org/users/:id/reset-password → temporary password
 *   GET    /api/org/api-keys                queue-machine keys
 *   POST   /api/org/api-keys                { name, branchId? } → the key, shown once
 *   DELETE /api/org/api-keys/:id            revoke a key
 *   GET    /api/org/audit                   recent security events
 *   GET    /api/org/export?from=&to=        every ticket in the range, as CSV
 *   DELETE /api/org                         { confirmName, password } — delete the organisation and its data
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { audit } from '../lib/audit.js';
import { asyncHandler, badRequest, conflict, forbidden, HttpError, notFound, parse } from '../lib/http.js';
import { sendEmail } from '../lib/mailer.js';
import { hashPassword, temporaryPassword } from '../lib/passwords.js';
import { planLimits } from '../lib/plans.js';
import { parseRange } from '../lib/scope.js';
import { hashSecret, newSecret } from '../lib/tokens.js';
import { requireAuth, requireEntitlement, requireRole } from '../middleware/auth.js';
import { cancelSubscriptionNow } from '../services/billing.js';
import { createLink } from './auth.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

const DEMO_LOCKED = 'This is a protected demo record, so the demo keeps working for everyone. Add your own branch or team member to try editing.';
const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
const text = (max) => z.string().trim().min(1).max(max);

const shapeBranch = (b) => ({
  id: b.id,
  name: b.name,
  city: b.city,
  counters: b.counters,
  isActive: b.is_active,
  demoProtected: b.is_demo_fixture,
  activeStaff: b.active_staff ?? 0,
  createdAt: b.created_at,
});

const shapeUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.full_name,
  role: u.role,
  branchId: u.branch_id,
  branchName: u.branch_name ?? null,
  counterNo: u.counter_no,
  isActive: u.is_active,
  mustChangePassword: u.must_change_password,
  demoProtected: u.is_demo_fixture,
  createdAt: u.created_at,
});

async function getBranch(db, orgId, id) {
  const { rows } = await db.query('SELECT * FROM falconmed_v4.branches WHERE id = $1 AND org_id = $2', [id, orgId]);
  if (!rows[0]) throw notFound('Branch not found');
  return rows[0];
}

async function getUser(db, orgId, id) {
  const { rows } = await db.query('SELECT * FROM falconmed_v4.users WHERE id = $1 AND org_id = $2', [id, orgId]);
  if (!rows[0]) throw notFound('Team member not found');
  return rows[0];
}

/**
 * Check that a role / branch / counter combination is valid inside the organisation.
 * Returns the normalised { branchId, counterNo }.
 */
async function checkPlacement(db, orgId, { role, branchId, counterNo, userId = null }) {
  if (role === 'admin') return { branchId: null, counterNo: null };
  if (!branchId) throw badRequest(role === 'manager' ? 'Choose the branch this manager runs' : 'Choose the branch this pharmacist works in');
  const branch = await getBranch(db, orgId, branchId);
  if (!branch.is_active) throw badRequest(`${branch.name} is inactive. Reactivate it first.`);
  if (role === 'manager') return { branchId, counterNo: null };

  if (!counterNo) throw badRequest('Choose a counter for this pharmacist');
  if (counterNo > branch.counters) throw badRequest(`${branch.name} has ${branch.counters} counters. Choose 1–${branch.counters}.`);
  const { rows } = await db.query(
    `SELECT full_name FROM falconmed_v4.users
      WHERE branch_id = $1 AND counter_no = $2 AND role = 'pharmacist' AND is_active AND id IS DISTINCT FROM $3`,
    [branchId, counterNo, userId],
  );
  if (rows[0]) throw conflict(`Counter ${counterNo} at ${branch.name} is already assigned to ${rows[0].full_name}`);
  return { branchId, counterNo };
}

/** 402 when the plan's limit on active branches or team members is already reached. */
async function assertWithinPlan(db, user, kind) {
  const limit = planLimits(user.org_plan)[kind];
  if (limit === null) return;
  const table = kind === 'branches' ? 'branches' : 'users';
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM falconmed_v4.${table} WHERE org_id = $1 AND is_active`, [user.org_id]);
  if (rows[0].n >= limit) {
    throw new HttpError(
      402,
      `Your plan includes up to ${limit} active ${kind === 'branches' ? 'branches' : 'team members'}. Upgrade under Billing to add more.`,
      'PLAN_LIMIT',
    );
  }
}

async function activeAdmins(db, orgId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE org_id = $1 AND role = 'admin' AND is_active`,
    [orgId],
  );
  return rows[0].n;
}

// ── organisation ─────────────────────────────────────────────────
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT o.id, o.name, o.slug, o.plan, o.created_at, o.trial_ends_at,
              (SELECT COUNT(*)::int FROM falconmed_v4.branches b WHERE b.org_id = o.id AND b.is_active) AS branches,
              (SELECT COUNT(*)::int FROM falconmed_v4.users u WHERE u.org_id = o.id AND u.is_active) AS team,
              (SELECT COUNT(*)::int FROM falconmed_v4.users u WHERE u.org_id = o.id AND u.is_active AND u.role <> 'admin') AS staff,
              EXISTS (SELECT 1 FROM falconmed_v4.tickets t
                       WHERE t.branch_id IN (SELECT id FROM falconmed_v4.branches WHERE org_id = o.id)) AS has_tickets
         FROM falconmed_v4.organizations o WHERE o.id = $1`,
      [req.user.org_id],
    );
    const o = rows[0];
    res.json({
      success: true,
      data: {
        id: o.id,
        name: o.name,
        slug: o.slug,
        plan: o.plan,
        createdAt: o.created_at,
        trialEndsAt: o.trial_ends_at,
        activeBranches: o.branches,
        activeTeam: o.team,
        demoProtected: o.plan === 'demo',
        // Getting-started checklist for new organisations.
        setup: { branch: o.branches > 0, team: o.staff > 0, data: o.has_tickets },
      },
    });
  }),
);

router.patch(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = parse(z.object({ name: text(80) }), req.body);
    const { rows: org } = await query('SELECT plan FROM falconmed_v4.organizations WHERE id = $1', [req.user.org_id]);
    if (org[0].plan === 'demo') throw forbidden('The demo organisation keeps its name so the demo stays the same for everyone.');
    await query('UPDATE falconmed_v4.organizations SET name = $2 WHERE id = $1', [req.user.org_id, name]);
    await audit(req, 'org.rename', { meta: { name } });
    res.json({ success: true, data: { name } });
  }),
);

// ── branches ─────────────────────────────────────────────────────
router.get(
  '/branches',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT b.*, COUNT(u.id) FILTER (WHERE u.is_active)::int AS active_staff
         FROM falconmed_v4.branches b
    LEFT JOIN falconmed_v4.users u ON u.branch_id = b.id
        WHERE b.org_id = $1
     GROUP BY b.id
     ORDER BY b.is_active DESC, b.name`,
      [req.user.org_id],
    );
    res.json({ success: true, data: rows.map(shapeBranch) });
  }),
);

const branchBody = z.object({
  name: text(80),
  city: text(60),
  counters: z.coerce.number().int().min(1).max(50),
});

router.post(
  '/branches',
  requireEntitlement,
  asyncHandler(async (req, res) => {
    const b = parse(branchBody, req.body);
    await assertWithinPlan({ query }, req.user, 'branches');
    const { rows: clash } = await query(
      'SELECT 1 FROM falconmed_v4.branches WHERE org_id = $1 AND lower(name) = lower($2)',
      [req.user.org_id, b.name],
    );
    if (clash.length) throw conflict(`You already have a branch called ${b.name}`);
    const { rows } = await query(
      `INSERT INTO falconmed_v4.branches (id, org_id, name, city, counters)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newId('br'), req.user.org_id, b.name, b.city, b.counters],
    );
    await audit(req, 'branch.create', { target: rows[0].id, meta: { name: b.name } });
    res.status(201).json({ success: true, data: shapeBranch(rows[0]) });
  }),
);

router.patch(
  '/branches/:id',
  asyncHandler(async (req, res) => {
    const patch = parse(branchBody.partial().extend({ isActive: z.boolean().optional() }), req.body);
    const data = await withTransaction(async (c) => {
      const branch = await getBranch(c, req.user.org_id, req.params.id);
      if (branch.is_demo_fixture) throw forbidden(DEMO_LOCKED);

      if (patch.name && patch.name.toLowerCase() !== branch.name.toLowerCase()) {
        const { rows } = await c.query(
          'SELECT 1 FROM falconmed_v4.branches WHERE org_id = $1 AND lower(name) = lower($2) AND id <> $3',
          [req.user.org_id, patch.name, branch.id],
        );
        if (rows.length) throw conflict(`You already have a branch called ${patch.name}`);
      }
      if (patch.counters !== undefined && patch.counters < branch.counters) {
        const { rows } = await c.query(
          `SELECT full_name, counter_no FROM falconmed_v4.users
            WHERE branch_id = $1 AND role = 'pharmacist' AND is_active AND counter_no > $2 ORDER BY counter_no LIMIT 1`,
          [branch.id, patch.counters],
        );
        if (rows[0]) throw conflict(`${rows[0].full_name} works at counter ${rows[0].counter_no}. Move them before reducing counters.`);
      }
      if (patch.isActive === false && branch.is_active) {
        const { rows } = await c.query(
          'SELECT COUNT(*)::int AS n FROM falconmed_v4.users WHERE branch_id = $1 AND is_active',
          [branch.id],
        );
        if (rows[0].n) throw conflict(`${branch.name} still has ${rows[0].n} active team member(s). Move or deactivate them first.`);
      }
      if (patch.isActive === true && !branch.is_active) await assertWithinPlan(c, req.user, 'branches');
      const { rows } = await c.query(
        `UPDATE falconmed_v4.branches
            SET name = COALESCE($2, name), city = COALESCE($3, city), counters = COALESCE($4, counters),
                is_active = COALESCE($5, is_active)
          WHERE id = $1 RETURNING *`,
        [branch.id, patch.name ?? null, patch.city ?? null, patch.counters ?? null, patch.isActive ?? null],
      );
      return shapeBranch(rows[0]);
    });
    await audit(req, 'branch.update', { target: data.id, meta: patch });
    res.json({ success: true, data });
  }),
);

// ── team ─────────────────────────────────────────────────────────
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.*, b.name AS branch_name
         FROM falconmed_v4.users u LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
        WHERE u.org_id = $1
     ORDER BY u.is_active DESC, CASE u.role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, b.name NULLS FIRST, u.counter_no, u.full_name`,
      [req.user.org_id],
    );
    res.json({ success: true, data: rows.map(shapeUser) });
  }),
);

const role = z.enum(['pharmacist', 'manager', 'admin']);

router.post(
  '/users',
  requireEntitlement,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        fullName: text(80),
        email: z.string().trim().toLowerCase().email().max(120),
        role,
        branchId: z.string().max(40).nullish(),
        counterNo: z.coerce.number().int().min(1).max(50).nullish(),
      }),
      req.body,
    );
    const temp = temporaryPassword();
    const data = await withTransaction(async (c) => {
      const { rows: taken } = await c.query('SELECT 1 FROM falconmed_v4.users WHERE email = $1', [body.email]);
      if (taken.length) throw conflict('An account with that email already exists');
      await assertWithinPlan(c, req.user, 'users');
      const place = await checkPlacement(c, req.user.org_id, body);
      const { rows } = await c.query(
        `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, branch_id, counter_no, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING *`,
        [newId('u'), req.user.org_id, body.email, body.fullName, body.role, place.branchId, place.counterNo, await hashPassword(temp)],
      );
      return rows[0];
    });
    await audit(req, 'user.create', { target: data.id, meta: { email: data.email, role: data.role } });
    // An invitation with a link to choose a password; the admin also sees a temporary one to pass on in person.
    const url = await createLink(data.id, 'invite');
    await sendEmail({
      to: data.email,
      subject: `${req.user.full_name} invited you to ${req.user.org_name} on FalconMed Elite`,
      greeting: `Hello ${data.full_name},`,
      lines: [`${req.user.full_name} added you to ${req.user.org_name} on FalconMed Elite. Choose your password to sign in. The link works for 3 days.`],
      action: { label: 'Choose your password', url },
    });
    const { rows } = await query('SELECT name FROM falconmed_v4.branches WHERE id = $1', [data.branch_id]);
    res.status(201).json({
      success: true,
      data: { user: shapeUser({ ...data, branch_name: rows[0]?.name }), temporaryPassword: temp },
    });
  }),
);

router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const patch = parse(
      z.object({
        fullName: text(80).optional(),
        role: role.optional(),
        branchId: z.string().max(40).nullish(),
        counterNo: z.coerce.number().int().min(1).max(50).nullish(),
        isActive: z.boolean().optional(),
      }),
      req.body,
    );
    const data = await withTransaction(async (c) => {
      const user = await getUser(c, req.user.org_id, req.params.id);
      if (user.is_demo_fixture) throw forbidden(DEMO_LOCKED);
      const self = user.id === req.user.id;
      if (self && patch.isActive === false) throw badRequest('You cannot deactivate your own account');
      if (self && patch.role && patch.role !== 'admin') throw badRequest('You cannot remove your own admin role');

      const next = {
        role: patch.role ?? user.role,
        branchId: patch.branchId !== undefined ? patch.branchId : user.branch_id,
        counterNo: patch.counterNo !== undefined ? patch.counterNo : user.counter_no,
        isActive: patch.isActive ?? user.is_active,
      };
      // Keep at least one active admin in every organisation.
      if (next.isActive && !user.is_active) await assertWithinPlan(c, req.user, 'users');
      if (user.role === 'admin' && user.is_active && (next.role !== 'admin' || !next.isActive) && (await activeAdmins(c, req.user.org_id)) <= 1) {
        throw badRequest('Your organisation needs at least one active admin');
      }
      // A pharmacist with a patient at the counter must finish first.
      if (user.role === 'pharmacist' && (!next.isActive || next.role !== 'pharmacist' || next.branchId !== user.branch_id || next.counterNo !== user.counter_no)) {
        const { rows } = await c.query(`SELECT ticket_no FROM falconmed_v4.tickets WHERE pharmacist_id = $1 AND status = 'in_service'`, [user.id]);
        if (rows[0]) throw conflict(`${user.full_name} is serving ticket ${rows[0].ticket_no}. Close it before changing their counter.`);
      }
      const place = next.isActive
        ? await checkPlacement(c, req.user.org_id, { ...next, userId: user.id })
        : { branchId: next.role === 'admin' ? null : next.branchId, counterNo: next.role === 'pharmacist' ? next.counterNo : null };

      const { rows } = await c.query(
        `UPDATE falconmed_v4.users
            SET full_name = COALESCE($2, full_name), role = $3, branch_id = $4, counter_no = $5, is_active = $6
          WHERE id = $1 RETURNING *`,
        [user.id, patch.fullName ?? null, next.role, place.branchId, place.counterNo, next.isActive],
      );
      return rows[0];
    });
    await audit(req, 'user.update', { target: data.id, meta: patch });
    const { rows } = await query('SELECT name FROM falconmed_v4.branches WHERE id = $1', [data.branch_id]);
    res.json({ success: true, data: shapeUser({ ...data, branch_name: rows[0]?.name }) });
  }),
);

router.post(
  '/users/:id/reset-password',
  asyncHandler(async (req, res) => {
    const user = await getUser({ query }, req.user.org_id, req.params.id);
    if (user.is_demo_fixture) throw forbidden(DEMO_LOCKED);
    if (user.id === req.user.id) throw badRequest('Change your own password from My account');
    const temp = temporaryPassword();
    await query(
      `UPDATE falconmed_v4.users
          SET password_hash = $2, must_change_password = TRUE, password_changed_at = now(),
              token_version = token_version + 1
        WHERE id = $1`,
      [user.id, await hashPassword(temp)],
    );
    await audit(req, 'user.password_reset', { target: user.id });
    res.json({ success: true, data: { temporaryPassword: temp } });
  }),
);


// ── queue API keys ───────────────────────────────────────────────
const shapeKey = (k) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  branchId: k.branch_id,
  branchName: k.branch_name ?? null,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at,
  revokedAt: k.revoked_at,
});

router.get(
  '/api-keys',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT k.*, b.name AS branch_name FROM falconmed_v4.api_keys k
    LEFT JOIN falconmed_v4.branches b ON b.id = k.branch_id
        WHERE k.org_id = $1 ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
      [req.user.org_id],
    );
    res.json({ success: true, data: rows.map(shapeKey) });
  }),
);

router.post(
  '/api-keys',
  requireEntitlement,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ name: text(60), branchId: z.string().max(40).nullish() }), req.body);
    if (body.branchId) await getBranch({ query }, req.user.org_id, body.branchId);
    const { secret } = newSecret(24);
    const key = `fmq_${secret}`;
    const { rows } = await query(
      `INSERT INTO falconmed_v4.api_keys (id, org_id, branch_id, name, prefix, key_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [newId('key'), req.user.org_id, body.branchId ?? null, body.name, key.slice(0, 10), hashSecret(key), req.user.id],
    );
    await audit(req, 'api_key.create', { target: rows[0].id, meta: { name: body.name, branchId: body.branchId ?? null } });
    res.status(201).json({ success: true, data: { key: shapeKey(rows[0]), secret: key } });
  }),
);

router.delete(
  '/api-keys/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE falconmed_v4.api_keys SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, req.user.org_id],
    );
    if (!rows[0]) throw notFound('Key not found');
    await audit(req, 'api_key.revoke', { target: rows[0].id });
    res.json({ success: true, data: shapeKey(rows[0]) });
  }),
);

// ── audit log ────────────────────────────────────────────────────
router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.action, a.target, a.ip, a.meta, a.created_at, u.full_name AS actor_name, u.email AS actor_email
         FROM falconmed_v4.audit_log a LEFT JOIN falconmed_v4.users u ON u.id = a.actor_id
        WHERE a.org_id = $1 ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
      [req.user.org_id],
    );
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        target: r.target,
        ip: r.ip,
        meta: r.meta,
        createdAt: r.created_at,
        actor: r.actor_name ? { name: r.actor_name, email: r.actor_email } : null,
      })),
    });
  }),
);

// ── data export ──────────────────────────────────────────────────
const EXPORT_COLUMNS = ['branch_id', 'branch_name', 'service_date', 'ticket_no', 'service_type', 'source', 'status',
  'arrived_at', 'called_at', 'finished_at', 'counter_no', 'pharmacist_email', 'identified', 'patient_ref'];

/** One CSV cell. Cells that a spreadsheet would run as a formula are prefixed with an apostrophe. */
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Always available, even after a trial ends, so an organisation can leave with its data. */
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const range = parseRange(req.query);
    const { rows } = await query(
      `SELECT t.branch_id, b.name AS branch_name, t.service_date, t.ticket_no, t.service_type, t.source, t.status,
              t.arrived_at, t.called_at, t.finished_at, t.counter_no, u.email AS pharmacist_email, t.identified, t.patient_ref
         FROM falconmed_v4.tickets t
         JOIN falconmed_v4.branches b ON b.id = t.branch_id
    LEFT JOIN falconmed_v4.users u ON u.id = t.pharmacist_id
        WHERE b.org_id = $1 AND t.service_date BETWEEN $2::date AND $3::date
     ORDER BY t.service_date, b.name, t.arrived_at`,
      [req.user.org_id, range.from, range.to],
    );
    await audit(req, 'org.export', { meta: { from: range.from, to: range.to, rows: rows.length } });
    const lines = [EXPORT_COLUMNS.join(','), ...rows.map((r) => EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="falconmed-tickets-${range.from}-to-${range.to}.csv"`);
    res.send(`${lines.join('\r\n')}\r\n`);
  }),
);

// ── delete the organisation ──────────────────────────────────────
router.delete(
  '/',
  asyncHandler(async (req, res) => {
    const { confirmName, password } = parse(z.object({ confirmName: z.string().max(200), password: z.string().min(1).max(200) }), req.body);
    const { rows: org } = await query('SELECT * FROM falconmed_v4.organizations WHERE id = $1', [req.user.org_id]);
    const o = org[0];
    if (o.plan === 'demo') throw forbidden('The demo organisation cannot be deleted.');
    if (confirmName.trim() !== o.name) throw badRequest('Type the organisation name exactly to confirm');
    const { rows: me } = await query('SELECT password_hash FROM falconmed_v4.users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(password, me[0].password_hash))) throw badRequest('Your password is not correct');

    // Stop billing first: if Stripe refuses, nothing is deleted.
    if (o.stripe_subscription_id) await cancelSubscriptionNow(o.stripe_subscription_id);

    await withTransaction(async (c) => {
      const branches = `SELECT id FROM falconmed_v4.branches WHERE org_id = $1`;
      await c.query(`DELETE FROM falconmed_v4.tickets WHERE branch_id IN (${branches})`, [o.id]);
      await c.query('DELETE FROM falconmed_v4.import_batches WHERE org_id = $1', [o.id]);
      await c.query('DELETE FROM falconmed_v4.api_keys WHERE org_id = $1', [o.id]);
      await c.query('UPDATE falconmed_v4.audit_log SET actor_id = NULL WHERE org_id = $1', [o.id]);
      await c.query('DELETE FROM falconmed_v4.users WHERE org_id = $1', [o.id]);
      await c.query('DELETE FROM falconmed_v4.branches WHERE org_id = $1', [o.id]);
      // The organisation row stays, anonymised, so billing records and the audit trail still reconcile.
      await c.query(
        `UPDATE falconmed_v4.organizations
            SET name = 'Deleted organisation', slug = $2, is_active = FALSE, deleted_at = now(),
                subscription_status = CASE WHEN stripe_subscription_id IS NULL THEN subscription_status ELSE 'canceled' END
          WHERE id = $1`,
        [o.id, `deleted-${crypto.randomBytes(4).toString('hex')}`],
      );
    });
    await audit(req, 'org.delete', { actorId: null, meta: { name: o.name } });
    res.json({ success: true, data: { deleted: true } });
  }),
);

export default router;
