import { z } from 'zod';
import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { badRequest, forbidden, parse } from './http.js';

const DAY_MS = 86_400_000;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const MAX_RANGE_DAYS = 366;

/** Today's date (YYYY-MM-DD) in the business timezone. */
export function todayISO(tz = env.TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

const toUTC = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw badRequest(`Invalid date: ${iso}`);
  return d;
};
const fromUTC = (d) => d.toISOString().slice(0, 10);

/** Parse ?from=&to= into a validated inclusive range plus the previous period of equal length. */
export function parseRange(q) {
  const { from, to } = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), q);
  const today = todayISO();
  const f = toUTC(from ?? to ?? today);
  const t = toUTC(to ?? from ?? today);
  if (f > t) throw badRequest('"from" must be on or before "to"');
  const days = Math.round((t - f) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return {
    from: fromUTC(f),
    to: fromUTC(t),
    days,
    prevFrom: fromUTC(new Date(f.getTime() - days * DAY_MS)),
    prevTo: fromUTC(new Date(f.getTime() - DAY_MS)),
  };
}

const scopeQuery = z.object({
  branchId: z.string().max(40).optional(),
  pharmacistId: z.string().max(60).optional(),
});

/**
 * Resolve what the caller may see. The server, never the browser, decides:
 *   pharmacist → own tickets only
 *   manager    → own branch (optionally one pharmacist in it)
 *   admin      → own organisation's network (optionally one branch / pharmacist)
 * Every scope carries orgId, so no query can reach another organisation.
 */
export function resolveScope(user, q) {
  const { branchId, pharmacistId } = parse(scopeQuery, q);
  const orgId = user.org_id;
  if (!orgId) throw forbidden();
  if (user.role === 'pharmacist') {
    if (pharmacistId && pharmacistId !== user.id) throw forbidden();
    if (branchId && branchId !== user.branch_id) throw forbidden();
    return { level: 'pharmacist', orgId, branchId: user.branch_id, pharmacistId: user.id };
  }
  if (user.role === 'manager') {
    if (branchId && branchId !== user.branch_id) throw forbidden('Managers can only view their own branch');
    return { level: pharmacistId ? 'pharmacist' : 'branch', orgId, branchId: user.branch_id, pharmacistId: pharmacistId ?? null };
  }
  return {
    level: pharmacistId ? 'pharmacist' : branchId ? 'branch' : 'network',
    orgId,
    branchId: branchId ?? null,
    pharmacistId: pharmacistId ?? null,
  };
}

/** Throw 403 unless the branch (and pharmacist, if given) belong to the user's organisation. */
export async function assertInOrg(user, { branchId, pharmacistId } = {}) {
  if (branchId) {
    const { rows } = await query('SELECT 1 FROM falconmed_v4.branches WHERE id = $1 AND org_id = $2', [branchId, user.org_id]);
    if (!rows.length) throw forbidden('That branch is not part of your organisation');
  }
  if (pharmacistId) {
    const { rows } = await query('SELECT 1 FROM falconmed_v4.users WHERE id = $1 AND org_id = $2', [pharmacistId, user.org_id]);
    if (!rows.length) throw forbidden('That pharmacist is not part of your organisation');
  }
}

/** SQL fragment: the branch column belongs to the organisation in placeholder $n. */
export const inOrg = (column, placeholder) =>
  `${column} IN (SELECT id FROM falconmed_v4.branches WHERE org_id = ${placeholder})`;

/**
 * Build a parameterised WHERE clause for falconmed_v4.ticket_metrics (alias t).
 * Returns { sql, params } — values are never interpolated into SQL text.
 */
export function where(scope, from, to, alias = 't') {
  const params = [from, to, scope.orgId];
  const parts = [`${alias}.service_date BETWEEN $1::date AND $2::date`, inOrg(`${alias}.branch_id`, '$3')];
  if (scope.branchId) {
    params.push(scope.branchId);
    parts.push(`${alias}.branch_id = $${params.length}`);
  }
  if (scope.pharmacistId) {
    params.push(scope.pharmacistId);
    parts.push(`${alias}.pharmacist_id = $${params.length}`);
  }
  return { sql: parts.join(' AND '), params };
}
