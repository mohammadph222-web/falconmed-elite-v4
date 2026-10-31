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
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { asyncHandler, badRequest, conflict, forbidden, notFound, parse } from '../lib/http.js';
import { temporaryPassword } from '../lib/passwords.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

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
      `SELECT o.id, o.name, o.slug, o.plan, o.created_at,
              (SELECT COUNT(*)::int FROM falconmed_v4.branches b WHERE b.org_id = o.id AND b.is_active) AS branches,
              (SELECT COUNT(*)::int FROM falconmed_v4.users u WHERE u.org_id = o.id AND u.is_active) AS team
         FROM falconmed_v4.organizations o WHERE o.id = $1`,
      [req.user.org_id],
    );
    const o = rows[0];
    res.json({
      success: true,
      data: { id: o.id, name: o.name, slug: o.slug, plan: o.plan, createdAt: o.created_at, activeBranches: o.branches, activeTeam: o.team, demoProtected: o.plan === 'demo' },
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
  asyncHandler(async (req, res) => {
    const b = parse(branchBody, req.body);
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
      const { rows } = await c.query(
        `UPDATE falconmed_v4.branches
            SET name = COALESCE($2, name), city = COALESCE($3, city), counters = COALESCE($4, counters),
                is_active = COALESCE($5, is_active)
          WHERE id = $1 RETURNING *`,
        [branch.id, patch.name ?? null, patch.city ?? null, patch.counters ?? null, patch.isActive ?? null],
      );
      return shapeBranch(rows[0]);
    });
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
      const place = await checkPlacement(c, req.user.org_id, body);
      const { rows } = await c.query(
        `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, branch_id, counter_no, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE) RETURNING *`,
        [newId('u'), req.user.org_id, body.email, body.fullName, body.role, place.branchId, place.counterNo, await bcrypt.hash(temp, 10)],
      );
      return rows[0];
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
      [user.id, await bcrypt.hash(temp, 10)],
    );
    res.json({ success: true, data: { temporaryPassword: temp } });
  }),
);

export default router;
