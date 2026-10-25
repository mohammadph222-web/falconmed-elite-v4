import { z } from 'zod';
import { env } from '../config/env.js';
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
 *   admin      → whole network (optionally one branch / pharmacist)
 */
export function resolveScope(user, q) {
  const { branchId, pharmacistId } = parse(scopeQuery, q);
  if (user.role === 'pharmacist') {
    if (pharmacistId && pharmacistId !== user.id) throw forbidden();
    if (branchId && branchId !== user.branch_id) throw forbidden();
    return { level: 'pharmacist', branchId: user.branch_id, pharmacistId: user.id };
  }
  if (user.role === 'manager') {
    if (branchId && branchId !== user.branch_id) throw forbidden('Managers can only view their own branch');
    return { level: pharmacistId ? 'pharmacist' : 'branch', branchId: user.branch_id, pharmacistId: pharmacistId ?? null };
  }
  return {
    level: pharmacistId ? 'pharmacist' : branchId ? 'branch' : 'network',
    branchId: branchId ?? null,
    pharmacistId: pharmacistId ?? null,
  };
}

/**
 * Build a parameterised WHERE clause for falconmed_v4.ticket_metrics (alias t).
 * Returns { sql, params } — values are never interpolated into SQL text.
 */
export function where(scope, from, to, alias = 't') {
  const params = [from, to];
  const parts = [`${alias}.service_date BETWEEN $1::date AND $2::date`];
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
