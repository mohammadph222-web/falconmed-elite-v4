import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { asyncHandler, badRequest, conflict, forbidden, HttpError, parse, unauthorized } from '../lib/http.js';
import { sendEmail } from '../lib/mailer.js';
import { BCRYPT_COST, hashPassword, newPasswordSchema } from '../lib/passwords.js';
import { hashSecret, newSecret } from '../lib/tokens.js';
import { loadUser, publicUser, requireAuth, signToken } from '../middleware/auth.js';

const router = Router();
const limited = (message) => ({ success: false, error: { code: 'RATE_LIMITED', message } });
const inTest = () => env.NODE_ENV === 'test';

// Slow down password guessing: 10 failed attempts per 15 minutes per IP…
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count towards the limit
  message: limited('Too many sign-in attempts. Try again in 15 minutes.'),
});

// …and per email address, so a botnet cannot spread guesses over many IPs.
// Applies to unknown addresses too, so the answer never reveals which emails exist.
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;
const LOCKED_MESSAGE = `Too many failed attempts for this account. Try again in ${LOCK_MINUTES} minutes, or reset your password.`;
const emailLimiter = rateLimit({
  windowMs: LOCK_MINUTES * 60 * 1000,
  limit: LOCK_AFTER,
  standardHeaders: false,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `email:${String(req.body?.email ?? '').trim().toLowerCase()}`,
  message: limited(LOCKED_MESSAGE),
});

// Emails sent on request (reset links): a few per hour per IP.
const emailSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: inTest,
  message: limited('Too many requests. Try again in an hour.'),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

// A real bcrypt hash used when the email is unknown, so response time
// does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('falconmed-timing-guard', BCRYPT_COST);

router.post(
  '/login',
  loginLimiter,
  emailLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const { rows } = await query(
      `SELECT u.*, (u.is_active AND o.is_active AND o.deleted_at IS NULL) AS can_sign_in,
              u.locked_until > now() AS is_locked,
              b.name AS branch_name, o.name AS org_name, o.plan AS org_plan, o.trial_ends_at,
              o.subscription_status, o.current_period_end, o.cancel_at_period_end
         FROM falconmed_v4.users u
         JOIN falconmed_v4.organizations o ON o.id = u.org_id
    LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
        WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    // The lock survives restarts and applies across every server instance.
    if (user?.is_locked) throw new HttpError(429, LOCKED_MESSAGE, 'RATE_LIMITED');

    if (!user || !ok || !user.can_sign_in) {
      if (user) {
        await query(
          `UPDATE falconmed_v4.users
              SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                  locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1`,
          [user.id, LOCK_AFTER, LOCK_MINUTES],
        );
        await audit(req, 'auth.login_failed', { orgId: user.org_id, actorId: user.id });
      }
      throw unauthorized('Incorrect email or password');
    }

    await query('UPDATE falconmed_v4.users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await audit(req, 'auth.login', { orgId: user.org_id, actorId: user.id });
    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  }),
);

// ── email links ──────────────────────────────────────────────────
const LINK_TTL_HOURS = { password_reset: 1, verify_email: 48, invite: 72 };

/**
 * Create a single-use link for a user and return its URL. Older unused links
 * for the same purpose stop working.
 */
export async function createLink(userId, purpose, db = { query }) {
  const ttl = LINK_TTL_HOURS[purpose];
  const stored = purpose === 'invite' ? 'password_reset' : purpose;
  const { secret, hash } = newSecret();
  await db.query('DELETE FROM falconmed_v4.auth_tokens WHERE user_id = $1 AND purpose = $2', [userId, stored]);
  await db.query(
    `INSERT INTO falconmed_v4.auth_tokens (token_hash, user_id, purpose, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [hash, userId, stored, ttl],
  );
  const page = stored === 'password_reset' ? 'reset-password' : 'verify-email';
  return `${env.APP_URL}/${page}?token=${secret}`;
}

/** Use up a link. Returns the user id, or throws when it is unknown, used or expired. */
async function consumeLink(db, token, purpose) {
  const { rows } = await db.query(
    `UPDATE falconmed_v4.auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
  RETURNING user_id`,
    [hashSecret(token), purpose],
  );
  if (!rows[0]) throw badRequest('This link is invalid or has expired. Request a new one.');
  return rows[0].user_id;
}

export async function sendVerificationEmail(user) {
  const url = await createLink(user.id, 'verify_email');
  await sendEmail({
    to: user.email,
    subject: 'Confirm your email for FalconMed Elite',
    greeting: `Hello ${user.full_name},`,
    lines: ['Please confirm this is your email address. The link works for 48 hours.'],
    action: { label: 'Confirm email', url },
  });
}

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
  skip: inTest,
  message: limited('Too many new organisations from this network. Try again in an hour.'),
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

    const hash = await hashPassword(body.password);
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
        `INSERT INTO falconmed_v4.users (id, org_id, email, full_name, role, password_hash, email_verified_at)
         VALUES ($1, $2, $3, $4, 'admin', $5, NULL)`,
        [userId, orgId, body.email, body.fullName, hash],
      );
      return userId;
    });
    const full = await loadUser(user);
    await audit(req, 'org.signup', { orgId: full.org_id, actorId: full.id });
    await sendVerificationEmail(full);
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
      [req.user.id, await hashPassword(newPassword)],
    );
    await audit(req, 'auth.password_change');
    const user = { ...req.user, must_change_password: false, token_version: upd[0].token_version };
    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  }),
);

/**
 * POST /api/auth/forgot-password — { email }
 * Always answers the same way, so it cannot be used to discover accounts.
 */
router.post(
  '/forgot-password',
  emailSendLimiter,
  asyncHandler(async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(120) }), req.body);
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.org_id, u.is_demo_fixture
         FROM falconmed_v4.users u JOIN falconmed_v4.organizations o ON o.id = u.org_id
        WHERE u.email = $1 AND u.is_active AND o.is_active AND o.deleted_at IS NULL`,
      [email],
    );
    const user = rows[0];
    if (user && !user.is_demo_fixture) {
      const url = await createLink(user.id, 'password_reset');
      await sendEmail({
        to: user.email,
        subject: 'Reset your FalconMed Elite password',
        greeting: `Hello ${user.full_name},`,
        lines: [
          'Someone asked to reset the password for this account. The link works for one hour.',
          'If it was not you, ignore this email: your password stays the same.',
        ],
        action: { label: 'Choose a new password', url },
      });
      await audit(req, 'auth.password_reset_requested', { orgId: user.org_id, actorId: user.id });
    }
    res.json({ success: true, data: { message: 'If an account exists for that email, we have sent a link to reset the password.' } });
  }),
);

/**
 * POST /api/auth/reset-password — { token, newPassword }
 * Sets the password, confirms the email (the link proves it) and signs out every session.
 */
router.post(
  '/reset-password',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = parse(z.object({ token: z.string().min(20).max(200), newPassword: newPasswordSchema }), req.body);
    const hash = await hashPassword(newPassword);
    const userId = await withTransaction(async (c) => {
      const id = await consumeLink(c, token, 'password_reset');
      await c.query(
        `UPDATE falconmed_v4.users
            SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(),
                token_version = token_version + 1, failed_logins = 0, locked_until = NULL,
                email_verified_at = COALESCE(email_verified_at, now())
          WHERE id = $1`,
        [id, hash],
      );
      return id;
    });
    const user = await loadUser(userId);
    if (!user?.is_active) throw unauthorized('Account is not active');
    await audit(req, 'auth.password_reset', { orgId: user.org_id, actorId: user.id });
    res.json({ success: true, data: { token: signToken(user), user: publicUser(user) } });
  }),
);

/** POST /api/auth/verify-email — { token } */
router.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    const userId = await withTransaction(async (c) => {
      const id = await consumeLink(c, token, 'verify_email');
      await c.query('UPDATE falconmed_v4.users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [id]);
      return id;
    });
    await audit(req, 'auth.email_verified', { actorId: userId, orgId: (await loadUser(userId))?.org_id });
    res.json({ success: true, data: { verified: true } });
  }),
);

/** POST /api/auth/resend-verification — send the confirmation email again. */
router.post(
  '/resend-verification',
  emailSendLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.email_verified_at) await sendVerificationEmail(req.user);
    res.json({ success: true, data: { sent: !req.user.email_verified_at } });
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

/** Public list of demo accounts for the login screen (emails and roles only). Empty when DEMO_LOGIN=false. */
router.get(
  '/demo-accounts',
  asyncHandler(async (req, res) => {
    if (!env.DEMO_LOGIN) return res.json({ success: true, data: [] });
    const { rows } = await query(
      `SELECT u.email, u.full_name, u.role, b.name AS branch_name, o.name AS org_name
         FROM falconmed_v4.users u
         JOIN falconmed_v4.organizations o ON o.id = u.org_id AND o.is_active AND o.plan = 'demo'
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
