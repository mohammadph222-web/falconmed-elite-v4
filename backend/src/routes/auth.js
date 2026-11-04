import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { audit } from '../lib/audit.js';
import { PgStore } from '../lib/rateLimitStore.js';
import { asyncHandler, badRequest, conflict, forbidden, HttpError, parse, unauthorized } from '../lib/http.js';
import { sendEmail } from '../lib/mailer.js';
import { BCRYPT_COST, hashPassword, newPasswordSchema } from '../lib/passwords.js';
import { hashSecret, newSecret } from '../lib/tokens.js';
import { decrypt, encrypt, matchStep, newRecoveryCodes, newTotpSecret, otpauthUrl, recoveryHash } from '../lib/totp.js';
import { loadUser, publicUser, requireAuth, signToken } from '../middleware/auth.js';

const router = Router();
const limited = (message) => ({ success: false, error: { code: 'RATE_LIMITED', message } });
const inTest = () => env.NODE_ENV === 'test';

// Slow down password guessing: 10 failed attempts per 15 minutes per IP…
const loginLimiter = rateLimit({
  store: new PgStore('login-ip'),
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
  store: new PgStore('login-email'),
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
  store: new PgStore('email-send'),
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: inTest,
  message: limited('Too many requests. Try again in an hour.'),
});

// Signed-in account changes (two-factor set-up and removal): counted per person, not per IP,
// so one person's typos never use up a whole pharmacy's shared connection.
const accountLimiter = rateLimit({
  store: new PgStore('account'),
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: limited('Too many attempts. Try again in 15 minutes.'),
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
    // The lock survives restarts and applies across every server instance. So that a
    // stranger cannot lock the owner out, the right password from the IP of the last
    // successful sign-in still gets in.
    const familiar = Boolean(user?.last_login_ip) && user.last_login_ip === req.ip;
    if (user?.is_locked && !(ok && familiar)) throw new HttpError(429, LOCKED_MESSAGE, 'RATE_LIMITED');

    if (!user || !ok || !user.can_sign_in) {
      if (user) await recordFailure(req, user);
      throw unauthorized('Incorrect email or password');
    }

    // Hashes from before v5 used a lower bcrypt cost: upgrade them while the password is at hand.
    if (bcrypt.getRounds(user.password_hash) < BCRYPT_COST) {
      await query('UPDATE falconmed_v4.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)]);
    }
    // With two-factor sign-in on, the password alone only earns a short-lived challenge.
    if (user.totp_enabled_at) return res.json({ success: true, data: mfaChallenge(user) });
    await completeSignIn(req, res, user);
  }),
);

/** A failed password or code. Failures older than the lock window are forgotten, so occasional typos never add up to a lock. */
async function recordFailure(req, user, action = 'auth.login_failed') {
  await query(
    `UPDATE falconmed_v4.users
        SET failed_logins = CASE WHEN last_failed_login_at IS NULL OR last_failed_login_at < now() - make_interval(mins => $3) THEN 1
                                 WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
            locked_until  = CASE WHEN (last_failed_login_at IS NOT NULL AND last_failed_login_at >= now() - make_interval(mins => $3))
                                      AND failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
            last_failed_login_at = now()
      WHERE id = $1`,
    [user.id, LOCK_AFTER, LOCK_MINUTES],
  );
  await audit(req, action, { orgId: user.org_id, actorId: user.id });
}

async function completeSignIn(req, res, user) {
  await query(
    `UPDATE falconmed_v4.users
        SET failed_logins = 0, locked_until = NULL, last_failed_login_at = NULL, last_login_at = now(), last_login_ip = $2
      WHERE id = $1`,
    [user.id, req.ip],
  );
  await audit(req, 'auth.login', { orgId: user.org_id, actorId: user.id });
  const full = await loadUser(user.id);
  res.json({ success: true, data: { token: signToken(full), user: publicUser(full) } });
}

// ── two-factor sign-in (authenticator app) ───────────────────────
const MFA_JWT = { issuer: 'falconmed-api', audience: 'falconmed-mfa' };

/** Five minutes to enter the second factor. Bound to the token version, so a password change voids it. */
const mfaChallenge = (user) => ({
  mfaRequired: true,
  mfaToken: jwt.sign({ tv: user.token_version }, env.JWT_SECRET, { ...MFA_JWT, subject: user.id, expiresIn: '5m', algorithm: 'HS256' }),
});
const codeSchema = z.string().trim().max(20).optional();

/** Check an authenticator code (never the same one twice) or use up a recovery code. Returns true on success. */
async function checkSecondFactor(user, { code, recoveryCode }) {
  if (code && user.totp_secret_enc) {
    const step = matchStep(decrypt(user.totp_secret_enc), code);
    if (step === null) return false;
    // Atomic: a code that was already used (or an older one) is refused, even by two requests at once.
    const { rowCount } = await query(
      `UPDATE falconmed_v4.users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [user.id, step],
    );
    return rowCount === 1;
  }
  if (recoveryCode) {
    const { rowCount } = await query(
      `UPDATE falconmed_v4.users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)`,
      [user.id, recoveryHash(recoveryCode)],
    );
    return rowCount === 1;
  }
  return false;
}

/** POST /api/auth/2fa/verify — { mfaToken, code | recoveryCode } → session */
router.post(
  '/2fa/verify',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ mfaToken: z.string().min(10).max(2000), code: codeSchema, recoveryCode: codeSchema }), req.body);
    let payload;
    try {
      payload = jwt.verify(body.mfaToken, env.JWT_SECRET, { ...MFA_JWT, algorithms: ['HS256'] });
    } catch {
      throw unauthorized('The sign-in took too long. Please start again.');
    }
    const { rows } = await query(
      `SELECT u.*, u.locked_until > now() AS is_locked, (u.is_active AND o.is_active AND o.deleted_at IS NULL) AS can_sign_in
         FROM falconmed_v4.users u JOIN falconmed_v4.organizations o ON o.id = u.org_id WHERE u.id = $1`,
      [payload.sub],
    );
    const user = rows[0];
    if (!user || !user.can_sign_in || user.token_version !== payload.tv || !user.totp_enabled_at) throw unauthorized('Please sign in again.');
    // Same rule as the password step: a lock keeps strangers out, not the owner on their usual connection.
    if (user.is_locked && user.last_login_ip !== req.ip) throw new HttpError(429, LOCKED_MESSAGE, 'RATE_LIMITED');
    if (!(await checkSecondFactor(user, body))) {
      await recordFailure(req, user, 'auth.2fa_failed');
      throw unauthorized('That code is not correct');
    }
    if (body.recoveryCode) await audit(req, 'auth.recovery_code_used', { orgId: user.org_id, actorId: user.id });
    await completeSignIn(req, res, user);
  }),
);

/** POST /api/auth/2fa/setup — start enrolment: a new secret to add to the authenticator app. */
router.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.is_demo_fixture) throw forbidden('Demo accounts are shared, so they cannot turn on two-factor sign-in.');
    if (req.user.totp_enabled_at) throw conflict('Two-factor sign-in is already on.');
    const secret = newTotpSecret();
    await query('UPDATE falconmed_v4.users SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1', [req.user.id, encrypt(secret)]);
    res.json({ success: true, data: { secret, otpauthUrl: otpauthUrl({ secret, email: req.user.email }) } });
  }),
);

/** POST /api/auth/2fa/enable — { code } from the app → on, with ten recovery codes shown once. */
router.post(
  '/2fa/enable',
  requireAuth,
  accountLimiter,
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().max(10) }), req.body);
    const { rows } = await query('SELECT * FROM falconmed_v4.users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (user.totp_enabled_at) throw conflict('Two-factor sign-in is already on.');
    if (!user.totp_secret_enc) throw badRequest('Start the set-up again.');
    if (!(await checkSecondFactor(user, { code }))) throw badRequest('That code is not correct. Check the time on your phone and try again.');
    const { codes, hashes } = newRecoveryCodes();
    await query('UPDATE falconmed_v4.users SET totp_enabled_at = now(), recovery_codes = $2 WHERE id = $1', [user.id, hashes]);
    await audit(req, 'auth.2fa_enabled');
    res.json({ success: true, data: { recoveryCodes: codes } });
  }),
);

/** POST /api/auth/2fa/disable — { password, code | recoveryCode } */
router.post(
  '/2fa/disable',
  requireAuth,
  accountLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ password: z.string().min(1).max(200), code: codeSchema, recoveryCode: codeSchema }), req.body);
    const { rows } = await query('SELECT * FROM falconmed_v4.users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user.totp_enabled_at) throw badRequest('Two-factor sign-in is not on.');
    if (req.user.role === 'admin' && req.user.require_admin_2fa) throw forbidden('Your organisation requires two-factor sign-in for admins.');
    if (!(await bcrypt.compare(body.password, user.password_hash))) throw badRequest('Your password is not correct');
    if (!(await checkSecondFactor(user, body))) throw badRequest('That code is not correct');
    await query(
      `UPDATE falconmed_v4.users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_codes = '{}' WHERE id = $1`,
      [user.id],
    );
    await audit(req, 'auth.2fa_disabled');
    res.json({ success: true, data: { enabled: false } });
  }),
);

/** POST /api/auth/2fa/recovery-codes — { code } → ten new codes; the old ones stop working. */
router.post(
  '/2fa/recovery-codes',
  requireAuth,
  accountLimiter,
  asyncHandler(async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().max(10) }), req.body);
    const { rows } = await query('SELECT * FROM falconmed_v4.users WHERE id = $1', [req.user.id]);
    if (!rows[0].totp_enabled_at) throw badRequest('Two-factor sign-in is not on.');
    if (!(await checkSecondFactor(rows[0], { code }))) throw badRequest('That code is not correct');
    const { codes, hashes } = newRecoveryCodes();
    await query('UPDATE falconmed_v4.users SET recovery_codes = $2 WHERE id = $1', [req.user.id, hashes]);
    await audit(req, 'auth.recovery_codes_renewed');
    res.json({ success: true, data: { recoveryCodes: codes } });
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
  store: new PgStore('signup'),
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
    await query('DELETE FROM falconmed_v4.auth_tokens WHERE user_id = $1 AND purpose = $2', [req.user.id, 'password_reset']);
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
    // The response must not take longer when the account exists, so the email goes out in the background.
    const job = (async () => {
      if (!user || user.is_demo_fixture) return;
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
    })().catch((err) => console.error('password reset email failed:', err.message));
    if (inTest()) await job; // tests read the email straight after the response
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
      const { rows: active } = await c.query(
        `SELECT 1 FROM falconmed_v4.users u JOIN falconmed_v4.organizations o ON o.id = u.org_id
          WHERE u.id = $1 AND u.is_active AND o.is_active AND o.deleted_at IS NULL`,
        [id],
      );
      if (!active.length) throw unauthorized('Account is not active');
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
    // Access to the inbox is not enough: with two-factor sign-in on, the code is still needed.
    if (user.totp_enabled_at) return res.json({ success: true, data: mfaChallenge(user) });
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
