import { query } from '../config/db.js';

/**
 * Record a security-relevant action. Never throws: a failed audit write is
 * logged, but must not undo or block the action itself.
 */
export async function audit(req, action, { orgId, actorId, target, meta } = {}, db = { query }) {
  try {
    await db.query(
      `INSERT INTO falconmed_v4.audit_log (org_id, actor_id, action, target, ip, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orgId ?? req?.user?.org_id ?? null,
        // An explicit `actorId: null` means "no actor" (e.g. the user was just deleted).
        actorId !== undefined ? actorId : req?.user?.id ?? null,
        action,
        target ?? null,
        req?.ip ?? null,
        meta ?? {},
      ],
    );
  } catch (err) {
    console.error(`audit "${action}" failed:`, err.message);
  }
}
