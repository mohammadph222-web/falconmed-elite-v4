import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { conflict, notFound } from '../lib/http.js';
import { todayISO } from '../lib/scope.js';

const round = (v, d = 1) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));

// Ticket number prefix per service line, as on a real queue machine.
export const SERVICE_PREFIX = { prescription: 'A', refill: 'R', consultation: 'C', otc: 'O', insurance: 'I' };

const TICKET_COLUMNS = `t.id, t.ticket_no, t.branch_id, t.service_type, t.source, t.identified, t.status,
  t.arrived_at, t.called_at, t.finished_at, t.counter_no, t.pharmacist_id`;

const shapeTicket = (r) => ({
  id: Number(r.id),
  ticketNo: r.ticket_no,
  branchId: r.branch_id,
  serviceType: r.service_type,
  source: r.source,
  identified: r.identified,
  status: r.status,
  arrivedAt: r.arrived_at,
  calledAt: r.called_at,
  finishedAt: r.finished_at,
  counterNo: r.counter_no,
  pharmacistId: r.pharmacist_id,
  pharmacistName: r.pharmacist_name ?? undefined,
});

/**
 * End-of-day housekeeping. Tickets still open from a previous business day
 * are closed honestly rather than left to block counters or distort live waits:
 *   waiting    → abandoned   (patient left before being called)
 *   in_service → auto_closed (called, but never closed at the counter; excluded
 *                             from service-time averages because the end is unknown)
 * Cheap: it only touches rows in the partial "open tickets" index.
 */
export async function closeStaleTickets(db = { query }) {
  const today = todayISO();
  const { rows } = await db.query(
    `WITH closed AS (
       UPDATE falconmed_v4.tickets
          SET status = CASE WHEN status = 'waiting' THEN 'abandoned' ELSE 'auto_closed' END
        WHERE status IN ('waiting', 'in_service') AND service_date < $1::date
    RETURNING status)
     SELECT COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
            COUNT(*) FILTER (WHERE status = 'auto_closed') AS auto_closed
       FROM closed`,
    [today],
  );
  return rows[0];
}

/** Register a patient arrival (queue machine / kiosk / simulator). */
export async function createTicket({ branchId, serviceType, source, identified, patientRef }) {
  return withTransaction(async (c) => {
    const { rows: br } = await c.query('SELECT id FROM falconmed_v4.branches WHERE id = $1 AND is_active', [branchId]);
    if (!br.length) throw notFound(`Branch ${branchId} not found`);

    const date = todayISO();
    // Serialise numbering per branch + day + service line (transaction-scoped lock).
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${branchId}|${date}|${serviceType}`]);
    const prefix = SERVICE_PREFIX[serviceType];
    const { rows: seq } = await c.query(
      `SELECT COUNT(*) + 1 AS n FROM falconmed_v4.tickets
        WHERE branch_id = $1 AND service_date = $2::date AND service_type = $3`,
      [branchId, date, serviceType],
    );
    const ticketNo = `${prefix}-${String(seq[0].n).padStart(3, '0')}`;

    const { rows } = await c.query(
      `INSERT INTO falconmed_v4.tickets
              (branch_id, service_date, ticket_no, service_type, source, identified, patient_ref)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7)
    RETURNING ${TICKET_COLUMNS.replaceAll('t.', '')}`,
      [branchId, date, ticketNo, serviceType, source, identified, patientRef ?? null],
    );
    return shapeTicket(rows[0]);
  });
}

/** The pharmacist's ticket currently at their counter, if any. */
export async function currentTicket(pharmacistId) {
  await closeStaleTickets();
  const { rows } = await query(
    `SELECT ${TICKET_COLUMNS} FROM falconmed_v4.tickets t
      WHERE t.pharmacist_id = $1 AND t.status = 'in_service'`,
    [pharmacistId],
  );
  return rows[0] ? shapeTicket(rows[0]) : null;
}

/**
 * Call the longest-waiting patient in the pharmacist's branch.
 * FOR UPDATE SKIP LOCKED lets several counters call at the same moment
 * without two of them ever receiving the same ticket.
 */
export async function callNext(user) {
  return withTransaction(async (c) => {
    await closeStaleTickets(c);
    const open = await c.query(
      `SELECT ticket_no FROM falconmed_v4.tickets WHERE pharmacist_id = $1 AND status = 'in_service' FOR UPDATE`,
      [user.id],
    );
    if (open.rows.length) throw conflict(`Finish ticket ${open.rows[0].ticket_no} before calling the next patient`);

    const { rows: nextRows } = await c.query(
      `SELECT id FROM falconmed_v4.tickets
        WHERE branch_id = $1 AND status = 'waiting'
     ORDER BY arrived_at, id
        LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      [user.branch_id],
    );
    if (!nextRows.length) return null;

    const { rows } = await c.query(
      `UPDATE falconmed_v4.tickets t
          SET status = 'in_service', called_at = now(), pharmacist_id = $2, counter_no = $3
        WHERE t.id = $1
    RETURNING ${TICKET_COLUMNS}`,
      [nextRows[0].id, user.id, user.counter_no],
    );
    return shapeTicket(rows[0]);
  });
}

/** Close the pharmacist's open ticket as served or no-show. */
export async function completeTicket(user, ticketId, outcome) {
  const { rows } = await query(
    `UPDATE falconmed_v4.tickets t
        SET status = $3, finished_at = now()
      WHERE t.id = $1 AND t.pharmacist_id = $2 AND t.status = 'in_service'
  RETURNING ${TICKET_COLUMNS}`,
    [ticketId, user.id, outcome],
  );
  if (!rows.length) throw notFound('No open ticket with that id at your counter');
  return shapeTicket(rows[0]);
}

/** Live picture of one branch (or the whole network) right now. */
export async function liveBoard(branchId) {
  await closeStaleTickets();
  const params = [];
  const branchFilter = branchId ? (params.push(branchId), `AND t.branch_id = $${params.length}`) : '';
  params.push(env.WAIT_TARGET_MIN);
  const targetIdx = `$${params.length}`;

  const [open, lastHour, counters] = await Promise.all([
    query(
      `SELECT ${TICKET_COLUMNS}, u.full_name AS pharmacist_name
         FROM falconmed_v4.tickets t
    LEFT JOIN falconmed_v4.users u ON u.id = t.pharmacist_id
        WHERE t.status IN ('waiting', 'in_service') ${branchFilter}
     ORDER BY t.arrived_at
        LIMIT 500`,
      params.slice(0, branchId ? 1 : 0),
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE t.status = 'served')                                AS served,
              COUNT(*) FILTER (WHERE t.status = 'no_show')                               AS no_show,
              AVG(t.wait_min)                                                            AS avg_wait,
              COUNT(*) FILTER (WHERE t.wait_min <= ${targetIdx})                         AS within_target,
              COUNT(*)                                                                   AS called
         FROM falconmed_v4.ticket_metrics t
        WHERE t.called_at >= now() - interval '60 minutes' ${branchFilter}`,
      params,
    ),
    query(
      `SELECT COALESCE(SUM(counters), 0) AS counters FROM falconmed_v4.branches
        WHERE is_active ${branchId ? 'AND id = $1' : ''}`,
      branchId ? [branchId] : [],
    ),
  ]);

  const now = Date.now();
  const tickets = open.rows.map(shapeTicket).map((t) => ({
    ...t,
    waitingMin: round(((t.calledAt ? new Date(t.calledAt).getTime() : now) - new Date(t.arrivedAt).getTime()) / 60000, 1),
    serviceMin: t.calledAt ? round((now - new Date(t.calledAt).getTime()) / 60000, 1) : null,
  }));
  const waiting = tickets.filter((t) => t.status === 'waiting');
  const inService = tickets.filter((t) => t.status === 'in_service');
  const lh = lastHour.rows[0];
  const oldestWaitMin = waiting.length ? waiting[0].waitingMin : 0;

  const alerts = buildAlerts({
    waitingCount: waiting.length,
    counters: counters.rows[0].counters,
    oldestWaitMin,
    avgWaitLastHour: lh.avg_wait,
    inService: inService.length,
  });

  return {
    asOf: new Date().toISOString(),
    targetWaitMin: env.WAIT_TARGET_MIN,
    counts: { waiting: waiting.length, inService: inService.length, counters: counters.rows[0].counters },
    oldestWaitMin,
    lastHour: {
      served: lh.served,
      noShow: lh.no_show,
      avgWaitMin: round(lh.avg_wait, 2),
      withinTargetRate: lh.called > 0 ? round((lh.within_target / lh.called) * 100, 1) : null,
    },
    waiting,
    inService,
    alerts,
  };
}

/** Operational alerts derived from live data only. Thresholds in docs/KPI_DEFINITIONS.md. */
export function buildAlerts({ waitingCount, counters, oldestWaitMin, avgWaitLastHour, inService }) {
  const target = env.WAIT_TARGET_MIN;
  const alerts = [];
  if (oldestWaitMin > target * 2) {
    alerts.push({
      id: 'oldest_wait',
      severity: 'critical',
      title: 'Patient waiting too long',
      message: `Longest wait is ${round(oldestWaitMin)} min (target ${target} min).`,
    });
  }
  if (avgWaitLastHour !== null && avgWaitLastHour > target) {
    alerts.push({
      id: 'avg_wait',
      severity: 'warning',
      title: 'Average wait above target',
      message: `Last 60 min average wait is ${round(avgWaitLastHour)} min.`,
    });
  }
  if (counters > 0 && waitingCount > counters * 4) {
    alerts.push({
      id: 'queue_length',
      severity: 'warning',
      title: 'Queue building up',
      message: `${waitingCount} patients waiting for ${counters} counters.`,
    });
  }
  if (waitingCount > 0 && inService === 0) {
    alerts.push({
      id: 'no_active_counter',
      severity: 'critical',
      title: 'No counter serving',
      message: `${waitingCount} waiting and no counter has called a patient.`,
    });
  }
  return alerts;
}
