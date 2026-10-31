import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { asyncHandler, badRequest, conflict, forbidden, parse, unauthorized } from '../lib/http.js';
import { newPasswordSchema } from '../lib/passwords.js';
import { loadUser, publicUser, requireAuth, signToken } from '../middleware/auth.js';

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
              b.name AS branch_name, o.name AS org_name, o.plan AS org_plan, o.trial_ends_at
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

// ── self-service sign-up ─────────────────────────────────────────
export const TRIAL_DAYS = 14;

// New organisations per IP: generous for an office sharing one connection,
// tight enough to stop scripted sign-ups.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipFailedRequests: true, // a typo should not use up an attempt
  skip: () => env.NODE_ENV === 'test',
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many new organisations from this network. Try again in an hour.' } },
});

const signupSchema = z.object({
  organisationName: z.string().trim().min(2, 'Enter your organisation’s name').max(80),
  fullName: z.string().trim().min(2, 'Enter your name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid work email').max(120),
  password: newPasswordSchema,
  acceptTerms: z.literal(true, { error: 'Please accept the terms to continue' }),
  // Hidden field: people never see it, so anything here came from a bot.
  website: z.string().max(200).optional(),
});

/** "Al Noor Pharmacy (Dubai)" → "al-noor-pharmacy-dubai" */
const slugify = (name) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'pharmacy';

/**
 * POST /api/auth/signup — create an organisation and its first admin,
 * start a free trial and sign the admin in.
 */
router.post(
  '/signup',
  signupLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(signupSchema, req.body);
    if (body.website) throw badRequest('Sign-up could not be completed');

    const hash = await bcrypt.hash(body.password, 10);
    const user = await withTransaction(async (c) => {
      const { rows: taken } = await c.query('SELECT 1 FROM falconmed_v4.users WHERE email = $1', [body.email]);
      if (taken.length) throw conflict('An account with that email already exists. Sign in instead.');

      // A unique, readable organisation ID: the name, plus a short suffix if it is taken.
      const base = slugify(body.organisationName);
      let slug = base;
      for (let i = 0; ; i++) {
        const { rows } = await c.query('SELECT 1 FROM falconmed_v4.organizations WHERE slug = $1', [slug]);
        if (!rows.length) break;
        slug = `${base}-${crypto.randomBytes(2).toString('hex')}`;
        if (i > 5) throw conflict('Please try a slightly different organisation name');
      }
      const orgId = `org_${crypto.randomBytes(5).toString('hex')}`;
      await c.query(
        `INSERT INTO falconmed_v4.organizations (id, name, slug, plan, trial_ends_at, created_via)
         VALUES ($1, $2, $3, 'trial', now() + make_interval(days => $4), 'signup')`,
        [orgId, body.organisationName, slug, TRIAL_DAYS],
      );
      const userId = `u_${crypto.randomBytes(5).toString('hex')}`;
      await c.query(
        `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, password_hash)
         VALUES ($1, $2, $3, $4, 'admin', $5)`,
        [userId, orgId, body.email, body.fullName, hash],
      );
      return userId;
    });
    const full = await loadUser(user);
    res.status(201).json({ success: true, data: { token: signToken(full), user: publicUser(full) } });
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
