import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { asyncHandler, forbidden, HttpError, unauthorized } from '../lib/http.js';
import { entitlement } from '../lib/plans.js';
import { hashSecret } from '../lib/tokens.js';

const PASSWORD_CHANGE_PATHS = new Set(['/api/auth/me', '/api/auth/password']);
const JWT_OPTS = { issuer: 'falconmed-api', audience: 'falconmed-app' };

export function signToken(user) {
  return jwt.sign({ role: user.role, orgId: user.org_id, branchId: user.branch_id, tv: user.token_version ?? 0 }, env.JWT_SECRET, {
    ...JWT_OPTS,
    subject: user.id,
    expiresIn: env.JWT_EXPIRES_IN,
    algorithm: 'HS256',
  });
}

export async function loadUser(id) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.org_id, u.branch_id, u.counter_no,
            u.must_change_password, u.token_version, u.is_demo_fixture, u.email_verified_at,
            (u.is_active AND o.is_active AND o.deleted_at IS NULL) AS is_active,
            b.name AS branch_name, o.name AS org_name, o.plan AS org_plan, o.trial_ends_at,
            o.subscription_status, o.current_period_end, o.cancel_at_period_end
       FROM falconmed_v4.users u
       JOIN falconmed_v4.organizations o ON o.id = u.org_id
  LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
      WHERE u.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export const publicUser = (u) => {
  const ent = entitlement(u);
  return {
    id: u.id,
    email: u.email,
    name: u.full_name,
    role: u.role,
    orgId: u.org_id,
    orgName: u.org_name,
    orgPlan: u.org_plan,
    trialEndsAt: u.trial_ends_at ?? null,
    subscriptionStatus: u.subscription_status ?? null,
    entitled: ent.ok,
    entitlementReason: ent.reason,
    emailVerified: Boolean(u.email_verified_at),
    branchId: u.branch_id,
    branchName: u.branch_name ?? null,
    counterNo: u.counter_no,
    mustChangePassword: Boolean(u.must_change_password),
    demoProtected: Boolean(u.is_demo_fixture),
  };
};

function readBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Verify the JWT and attach the current (still-active) user to req.user. */
export const requireAuth = asyncHandler(async (req, res, next) => {
  const token = readBearer(req);
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { ...JWT_OPTS, algorithms: ['HS256'] });
  } catch {
    throw unauthorized('Session expired. Please sign in again.');
  }
  const user = await loadUser(payload.sub);
  if (!user || !user.is_active) throw unauthorized('Account is not active');
  // A password change or reset signs out every session issued before it.
  if ((payload.tv ?? 0) !== user.token_version) {
    throw unauthorized('Your password was changed. Please sign in again.');
  }
  // A temporary password must be replaced before anything else.
  if (user.must_change_password && !PASSWORD_CHANGE_PATHS.has(req.baseUrl + req.path)) {
    throw new HttpError(403, 'Please choose a new password first', 'PASSWORD_CHANGE_REQUIRED');
  }
  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};

const NOT_ENTITLED = {
  trial_ended: 'Your free trial has ended. An admin can choose a plan under Billing to continue.',
  subscription_inactive: 'Your subscription is not active. An admin can update it under Billing to continue.',
};

/** 402 unless the user's organisation is on an active trial or subscription. Use after requireAuth. */
export const requireEntitlement = (req, res, next) => {
  const ent = entitlement(req.user);
  if (!ent.ok) return next(new HttpError(402, NOT_ENTITLED[ent.reason], 'SUBSCRIPTION_REQUIRED'));
  next();
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Resolve an X-Queue-Key to the organisation (and optional branch) it belongs to.
 * Returns null when the key is unknown or revoked.
 */
async function resolveQueueKey(key) {
  // Legacy shared key from the environment: demo organisations only.
  if (env.QUEUE_API_KEY && safeEqual(key, env.QUEUE_API_KEY)) return { legacy: true, orgId: null, branchId: null };
  const { rows } = await query(
    `UPDATE falconmed_v4.api_keys k
        SET last_used_at = now()
       FROM falconmed_v4.organizations o
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND o.id = k.org_id
        AND o.is_active AND o.deleted_at IS NULL
  RETURNING k.id, k.org_id, k.branch_id, o.plan, o.trial_ends_at, o.subscription_status`,
    [hashSecret(key)],
  );
  const k = rows[0];
  if (!k) return null;
  return { legacy: false, id: k.id, orgId: k.org_id, branchId: k.branch_id, entitlement: entitlement(k) };
}

/**
 * Queue-machine ingestion: accept either an organisation's X-Queue-Key
 * (kiosk / hardware integration) or a signed-in admin/manager (the web simulator).
 * Sets req.queueKey = { orgId, branchId, legacy } for key requests.
 */
export const requireQueueKeyOrStaff = asyncHandler(async (req, res, next) => {
  const key = req.headers['x-queue-key'];
  if (key) {
    const resolved = await resolveQueueKey(key);
    if (!resolved) throw unauthorized('Invalid queue key');
    if (resolved.entitlement && !resolved.entitlement.ok) throw new HttpError(402, NOT_ENTITLED[resolved.entitlement.reason], 'SUBSCRIPTION_REQUIRED');
    req.queueKey = resolved;
    return next();
  }
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!['admin', 'manager'].includes(req.user.role)) return next(forbidden());
    requireEntitlement(req, res, next);
  });
});
