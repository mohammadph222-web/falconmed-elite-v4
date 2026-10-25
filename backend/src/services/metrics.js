import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { todayISO, where } from '../lib/scope.js';

const round = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(Number(v).toFixed(d)));
const pct = (num, den, d = 1) => (den > 0 ? round((num / den) * 100, d) : null);

/** Next free $n placeholder after the params already in the list. */
const next = (params, value) => {
  params.push(value);
  return `$${params.length}`;
};

async function rawSummary(scope, from, to, cutoff = null) {
  const w = where(scope, from, to);
  const params = [...w.params];
  const target = next(params, env.WAIT_TARGET_MIN);
  // Like-for-like comparison: only count tickets that had arrived by the cutoff.
  const cutoffSql = cutoff ? `AND arrived_at <= ${next(params, cutoff)}::timestamptz` : '';
  const { rows } = await query(
    `SELECT
        COUNT(*)                                                       AS total,
        COUNT(*) FILTER (WHERE status = 'served')                      AS served,
        COUNT(*) FILTER (WHERE status = 'no_show')                     AS no_show,
        COUNT(*) FILTER (WHERE status = 'waiting')                     AS waiting,
        COUNT(*) FILTER (WHERE status = 'in_service')                  AS in_service,
        COUNT(*) FILTER (WHERE status = 'abandoned')                   AS abandoned,
        COUNT(*) FILTER (WHERE status = 'auto_closed')                 AS auto_closed,
        COUNT(*) FILTER (WHERE identified)                             AS identified,
        COUNT(*) FILTER (WHERE called_at IS NOT NULL)                  AS called,
        COUNT(*) FILTER (WHERE called_at IS NOT NULL AND wait_min <= ${target}) AS within_target,
        AVG(wait_min)                                                  AS avg_wait,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY wait_min)          AS p90_wait,
        AVG(service_min)                                               AS avg_service,
        AVG(turnaround_min)                                            AS avg_turnaround,
        COUNT(DISTINCT pharmacist_id)                                  AS active_staff
       FROM falconmed_v4.ticket_metrics t
      WHERE ${w.sql} ${cutoffSql}`,
    params,
  );
  return rows[0];
}

function shapeSummary(r) {
  const closed = r.served + r.no_show;
  return {
    totalTickets: r.total,
    served: r.served,
    noShow: r.no_show,
    waiting: r.waiting,
    inService: r.in_service,
    abandoned: r.abandoned, // left before being called (closed at end of day)
    autoClosed: r.auto_closed, // called but never closed at the counter
    identified: r.identified,
    unidentified: r.total - r.identified,
    identifiedRate: pct(r.identified, r.total),
    serveRate: pct(r.served, closed),
    noShowRate: pct(r.no_show, closed),
    avgWaitMin: round(r.avg_wait, 2),
    p90WaitMin: round(r.p90_wait, 2),
    avgServiceMin: round(r.avg_service, 2),
    avgTurnaroundMin: round(r.avg_turnaround, 2),
    withinTargetRate: pct(r.within_target, r.called),
    activeStaff: r.active_staff,
  };
}

/** Change from the previous period: absolute for rates/minutes, % for counts. */
function deltas(cur, prev) {
  const out = {};
  for (const k of Object.keys(cur)) {
    const a = cur[k];
    const b = prev[k];
    if (a === null || b === null || typeof a !== 'number' || typeof b !== 'number') {
      out[k] = null;
    } else if (/Rate$|Min$/.test(k)) {
      out[k] = round(a - b, 2);
    } else {
      out[k] = b > 0 ? round(((a - b) / b) * 100, 1) : null;
    }
  }
  return out;
}

async function peakHour(scope, from, to) {
  const w = where(scope, from, to);
  const params = [...w.params];
  const tz = next(params, env.TIMEZONE);
  const { rows } = await query(
    `SELECT EXTRACT(HOUR FROM arrived_at AT TIME ZONE ${tz})::int AS hour, COUNT(*) AS n
       FROM falconmed_v4.ticket_metrics t
      WHERE ${w.sql}
   GROUP BY 1 ORDER BY n DESC, hour LIMIT 1`,
    params,
  );
  return rows[0] ? { hour: rows[0].hour, tickets: rows[0].n } : null;
}

/**
 * Headline KPIs with a fair comparison.
 *
 * If the period ends today, today is only partly over. Comparing it with a
 * complete previous period would make every morning look like a collapse
 * ("-100 % vs yesterday" at 07:00). So the previous period is cut at the same
 * point in time: e.g. today until 10:15 vs yesterday until 10:15, or the last
 * 7 days until now vs the 7 days before, until the same time.
 */
export async function summary(scope, range) {
  const partial = range.to === todayISO();
  const prevCutoff = partial ? new Date(Date.now() - range.days * 86_400_000).toISOString() : null;
  const [cur, prev, peak] = await Promise.all([
    rawSummary(scope, range.from, range.to),
    rawSummary(scope, range.prevFrom, range.prevTo, prevCutoff),
    peakHour(scope, range.from, range.to),
  ]);
  const current = shapeSummary(cur);
  const previous = shapeSummary(prev);
  return {
    range,
    targetWaitMin: env.WAIT_TARGET_MIN,
    current,
    previous,
    change: deltas(current, previous),
    comparison: {
      mode: partial ? 'same_time' : 'full_period',
      previousCutoff: prevCutoff, // null when both periods are complete
      asOf: new Date().toISOString(),
    },
    peakHour: peak,
  };
}

export async function hourly(scope, range) {
  const w = where(scope, range.from, range.to);
  const params = [...w.params];
  const tz = next(params, env.TIMEZONE);
  const { rows } = await query(
    `SELECT h.hour,
            COUNT(t.id)                                         AS tickets,
            COUNT(t.id) FILTER (WHERE t.status = 'no_show')     AS no_show,
            AVG(t.wait_min)                                     AS avg_wait,
            AVG(t.service_min)                                  AS avg_service
       FROM generate_series(0, 23) AS h(hour)
  LEFT JOIN falconmed_v4.ticket_metrics t
         ON EXTRACT(HOUR FROM t.arrived_at AT TIME ZONE ${tz}) = h.hour
        AND ${w.sql}
   GROUP BY h.hour
   ORDER BY h.hour`,
    params,
  );
  return rows.map((r) => ({
    hour: r.hour,
    label: `${String(r.hour).padStart(2, '0')}:00`,
    tickets: r.tickets,
    avgPerDay: round(r.tickets / range.days, 1),
    noShow: r.no_show,
    avgWaitMin: round(r.avg_wait, 2),
    avgServiceMin: round(r.avg_service, 2),
  }));
}

export async function daily(scope, range) {
  const w = where(scope, range.from, range.to);
  const params = [...w.params];
  const target = next(params, env.WAIT_TARGET_MIN);
  const { rows } = await query(
    `SELECT d::date AS date,
            COUNT(t.id)                                                      AS tickets,
            COUNT(t.id) FILTER (WHERE t.status = 'served')                   AS served,
            COUNT(t.id) FILTER (WHERE t.status = 'no_show')                  AS no_show,
            COUNT(t.id) FILTER (WHERE t.called_at IS NOT NULL)               AS called,
            COUNT(t.id) FILTER (WHERE t.called_at IS NOT NULL AND t.wait_min <= ${target}) AS within_target,
            AVG(t.wait_min)                                                  AS avg_wait,
            AVG(t.service_min)                                               AS avg_service
       FROM generate_series($1::date, $2::date, interval '1 day') AS d
  LEFT JOIN falconmed_v4.ticket_metrics t ON t.service_date = d::date AND ${w.sql}
   GROUP BY d
   ORDER BY d`,
    params,
  );
  return rows.map((r) => ({
    date: r.date,
    tickets: r.tickets,
    served: r.served,
    noShow: r.no_show,
    serveRate: pct(r.served, r.served + r.no_show),
    withinTargetRate: pct(r.within_target, r.called),
    avgWaitMin: round(r.avg_wait, 2),
    avgServiceMin: round(r.avg_service, 2),
  }));
}

/** Per-pharmacist performance, including pharmacists with no tickets in the range. */
export async function staff(scope, range) {
  const params = [range.from, range.to];
  const target = next(params, env.WAIT_TARGET_MIN);
  const filters = [`u.role = 'pharmacist'`, `u.is_active`];
  if (scope.branchId) filters.push(`u.branch_id = ${next(params, scope.branchId)}`);
  if (scope.pharmacistId) filters.push(`u.id = ${next(params, scope.pharmacistId)}`);

  const { rows } = await query(
    `SELECT u.id, u.full_name, u.counter_no, u.branch_id, b.name AS branch_name,
            COUNT(t.id) FILTER (WHERE t.status = 'served')                    AS served,
            COUNT(t.id) FILTER (WHERE t.status = 'no_show')                   AS no_show,
            COUNT(t.id) FILTER (WHERE t.wait_min <= ${target})                AS within_target,
            COUNT(t.id)                                                       AS called,
            AVG(t.service_min)                                                AS avg_service,
            AVG(t.wait_min)                                                   AS avg_wait,
            COUNT(DISTINCT t.service_date)                                    AS days_worked
       FROM falconmed_v4.users u
       JOIN falconmed_v4.branches b ON b.id = u.branch_id
  LEFT JOIN falconmed_v4.ticket_metrics t
         ON t.pharmacist_id = u.id AND t.service_date BETWEEN $1::date AND $2::date
      WHERE ${filters.join(' AND ')}
   GROUP BY u.id, b.name
   ORDER BY served DESC, u.full_name`,
    params,
  );

  const totalServed = rows.reduce((s, r) => s + r.served, 0);
  return rows.map((r) => ({
    id: r.id,
    name: r.full_name,
    counterNo: r.counter_no,
    branchId: r.branch_id,
    branchName: r.branch_name,
    served: r.served,
    noShow: r.no_show,
    servedPerDay: r.days_worked > 0 ? round(r.served / r.days_worked, 1) : 0,
    sharePct: pct(r.served, totalServed),
    avgServiceMin: round(r.avg_service, 2),
    avgWaitMin: round(r.avg_wait, 2),
    withinTargetRate: pct(r.within_target, r.called),
  }));
}

/**
 * Branch comparison. Status bands are derived from the share of patients
 * called within the wait target (documented in docs/KPI_DEFINITIONS.md):
 *   ≥ 90 % on_target · 75–90 % watch · < 75 % action · no data → no_data
 */
export async function branches(scope, range) {
  const params = [range.from, range.to];
  const target = next(params, env.WAIT_TARGET_MIN);
  const filters = ['b.is_active'];
  if (scope.branchId) filters.push(`b.id = ${next(params, scope.branchId)}`);

  const { rows } = await query(
    `SELECT b.id, b.name, b.city, b.counters,
            COUNT(t.id)                                                        AS tickets,
            COUNT(t.id) FILTER (WHERE t.status = 'served')                     AS served,
            COUNT(t.id) FILTER (WHERE t.status = 'no_show')                    AS no_show,
            COUNT(t.id) FILTER (WHERE t.identified)                            AS identified,
            COUNT(t.id) FILTER (WHERE t.called_at IS NOT NULL)                 AS called,
            COUNT(t.id) FILTER (WHERE t.called_at IS NOT NULL AND t.wait_min <= ${target}) AS within_target,
            AVG(t.wait_min)                                                    AS avg_wait,
            AVG(t.service_min)                                                 AS avg_service
       FROM falconmed_v4.branches b
  LEFT JOIN falconmed_v4.ticket_metrics t
         ON t.branch_id = b.id AND t.service_date BETWEEN $1::date AND $2::date
      WHERE ${filters.join(' AND ')}
   GROUP BY b.id
   ORDER BY tickets DESC, b.name`,
    params,
  );

  return rows.map((r) => {
    const withinTargetRate = pct(r.within_target, r.called);
    const status =
      withinTargetRate === null ? 'no_data' : withinTargetRate >= 90 ? 'on_target' : withinTargetRate >= 75 ? 'watch' : 'action';
    return {
      id: r.id,
      name: r.name,
      city: r.city,
      counters: r.counters,
      tickets: r.tickets,
      ticketsPerDay: round(r.tickets / range.days, 1),
      served: r.served,
      noShow: r.no_show,
      serveRate: pct(r.served, r.served + r.no_show),
      identifiedRate: pct(r.identified, r.tickets),
      withinTargetRate,
      avgWaitMin: round(r.avg_wait, 2),
      avgServiceMin: round(r.avg_service, 2),
      status,
    };
  });
}

/** Ticket mix by service type and by registration channel. */
export async function mix(scope, range) {
  const w = where(scope, range.from, range.to);
  const [byService, bySource] = await Promise.all([
    query(
      `SELECT service_type AS key, COUNT(*) AS n, AVG(service_min) AS avg_service
         FROM falconmed_v4.ticket_metrics t WHERE ${w.sql} GROUP BY 1 ORDER BY n DESC`,
      w.params,
    ),
    query(`SELECT source AS key, COUNT(*) AS n FROM falconmed_v4.ticket_metrics t WHERE ${w.sql} GROUP BY 1 ORDER BY n DESC`, w.params),
  ]);
  const total = byService.rows.reduce((s, r) => s + r.n, 0);
  return {
    total,
    byService: byService.rows.map((r) => ({ key: r.key, tickets: r.n, sharePct: pct(r.n, total), avgServiceMin: round(r.avg_service, 2) })),
    bySource: bySource.rows.map((r) => ({ key: r.key, tickets: r.n, sharePct: pct(r.n, total) })),
  };
}
