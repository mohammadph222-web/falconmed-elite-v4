import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../config/db.js';
import { asyncHandler, parse, unauthorized } from '../lib/http.js';
import { publicUser, requireAuth, signToken } from '../middleware/auth.js';

const router = Router();

// Slow down password guessing: 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
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
      `SELECT u.*, b.name AS branch_name
         FROM falconmed_v4.users u LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
        WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || !user.is_active) throw unauthorized('Incorrect email or password');

    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  }),
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

/** Public list of demo accounts for the login screen (emails and roles only). */
router.get(
  '/demo-accounts',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT DISTINCT ON (u.role) u.email, u.full_name, u.role, b.name AS branch_name
         FROM falconmed_v4.users u LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
        WHERE u.is_active AND u.email IN ('pharmacist@demo.falconmed.app', 'manager@demo.falconmed.app', 'admin@demo.falconmed.app')
     ORDER BY u.role, u.email`,
    );
    const order = { pharmacist: 0, manager: 1, admin: 2 };
    rows.sort((a, b) => order[a.role] - order[b.role]);
    res.json({
      success: true,
      data: rows.map((r) => ({ email: r.email, name: r.full_name, role: r.role, branchName: r.branch_name })),
    });
  }),
);

export default router;
