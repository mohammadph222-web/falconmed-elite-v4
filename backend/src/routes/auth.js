import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../config/db.js';
import { asyncHandler, badRequest, forbidden, parse, unauthorized } from '../lib/http.js';
import { newPasswordSchema } from '../lib/passwords.js';
import { publicUser, requireAuth, signToken } from '../middleware/auth.js';

const router = Router();

// Slow down password guessing: 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count towards the limit
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again in 15 minutes.' } },
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

// A real bcrypt hash used when the email is unknown, so response time
// does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('falconmed-timing-guard', 10);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const { rows } = await query(
      `SELECT u.*, (u.is_active AND o.is_active) AS can_sign_in,
              b.name AS branch_name, o.name AS org_name, o.plan AS org_plan
         FROM falconmed_v4.users u
         JOIN falconmed_v4.organizations o ON o.id = u.org_id
    LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
        WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !user.can_sign_in) throw unauthorized('Incorrect email or password');

    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  }),
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

/**
 * POST /api/auth/password — { currentPassword, newPassword }
 * Signs out every other session and returns a fresh token for this one.
 */
router.post(
  '/password',
  loginLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parse(
      z.object({ currentPassword: z.string().min(1).max(200), newPassword: newPasswordSchema }),
      req.body,
    );
    if (req.user.is_demo_fixture) throw forbidden('Demo accounts keep their shared password so everyone can sign in.');
    const { rows } = await query('SELECT password_hash FROM falconmed_v4.users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) throw badRequest('Your current password is not correct');
    if (currentPassword === newPassword) throw badRequest('Choose a password different from the current one');

    const { rows: upd } = await query(
      `UPDATE falconmed_v4.users
          SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(),
              token_version = token_version + 1
        WHERE id = $1 RETURNING token_version`,
      [req.user.id, await bcrypt.hash(newPassword, 10)],
    );
    const user = { ...req.user, must_change_password: false, token_version: upd[0].token_version };
    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  }),
);

// Shown on the login screen, in this order. The last one belongs to a second
// demo organisation, to show that organisations are fully separated.
const DEMO_EMAILS = [
  'pharmacist@demo.falconmed.app',
  'manager@demo.falconmed.app',
  'admin@demo.falconmed.app',
  'admin@oasis.demo.falconmed.app',
];

/** Public list of demo accounts for the login screen (emails and roles only). */
router.get(
  '/demo-accounts',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT u.email, u.full_name, u.role, b.name AS branch_name, o.name AS org_name
         FROM falconmed_v4.users u
         JOIN falconmed_v4.organizations o ON o.id = u.org_id AND o.is_active
    LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
        WHERE u.is_active AND u.email = ANY($1)`,
      [DEMO_EMAILS],
    );
    rows.sort((a, b) => DEMO_EMAILS.indexOf(a.email) - DEMO_EMAILS.indexOf(b.email));
    res.json({
      success: true,
      data: rows.map((r) => ({ email: r.email, name: r.full_name, role: r.role, branchName: r.branch_name, orgName: r.org_name })),
    });
  }),
);

export default router;
