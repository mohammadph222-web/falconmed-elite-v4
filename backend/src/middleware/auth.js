import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { asyncHandler, forbidden, unauthorized } from '../lib/http.js';

export function signToken(user) {
  return jwt.sign({ role: user.role, orgId: user.org_id, branchId: user.branch_id }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

export async function loadUser(id) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.org_id, u.branch_id, u.counter_no,
            (u.is_active AND o.is_active) AS is_active,
            b.name AS branch_name, o.name AS org_name, o.plan AS org_plan
       FROM falconmed_v4.users u
       JOIN falconmed_v4.organizations o ON o.id = u.org_id
  LEFT JOIN falconmed_v4.branches b ON b.id = u.branch_id
      WHERE u.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.full_name,
  role: u.role,
  orgId: u.org_id,
  orgName: u.org_name,
  orgPlan: u.org_plan,
  branchId: u.branch_id,
  branchName: u.branch_name ?? null,
  counterNo: u.counter_no,
});

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
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    throw unauthorized('Session expired. Please sign in again.');
  }
  const user = await loadUser(payload.sub);
  if (!user || !user.is_active) throw unauthorized('Account is not active');
  req.user = user;
  next();
});

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  next();
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Queue-machine ingestion: accept either the shared X-Queue-Key (kiosk /
 * hardware integration) or a signed-in admin/manager (the web simulator).
 */
export const requireQueueKeyOrStaff = (req, res, next) => {
  const key = req.headers['x-queue-key'];
  if (key) {
    if (!safeEqual(key, env.QUEUE_API_KEY)) return next(unauthorized('Invalid queue key'));
    req.viaQueueKey = true;
    return next();
  }
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (!['admin', 'manager'].includes(req.user.role)) return next(forbidden());
    next();
  });
};
