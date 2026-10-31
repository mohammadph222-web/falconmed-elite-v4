/**
 * CSV importer with a data-quality report.
 *
 * Flow: parse  →  map columns  →  validate every row  →  report.
 * Nothing is written until the user confirms (commitImport), and every
 * import is a batch that can be rolled back.
 *
 * Privacy: columns that identify patients (names, phones, Emirates ID,
 * raw MRN…) are dropped before anything else happens, and any cell that
 * looks like an Emirates ID is never stored.
 */
import { parse as parseCsv } from 'csv-parse/sync';
import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { badRequest } from '../lib/http.js';
import { localDateISO, localHour, localPartsToUtc } from '../lib/time.js';

export const MAX_ROWS = 50_000;
const MAX_EXAMPLES = 8;

// ── column mapping ───────────────────────────────────────────────
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const ALIASES = {
  ticket_no: ['ticket_no', 'ticket', 'ticket_number', 'token', 'token_no', 'queue_no', 'queue_number', 'number', 'no'],
  branch: ['branch', 'branch_id', 'branch_name', 'site', 'location', 'pharmacy', 'store'],
  date: ['date', 'service_date', 'day', 'visit_date'],
  arrived_at: ['arrived_at', 'arrival', 'arrival_time', 'arrived', 'issued', 'issued_at', 'issue_time', 'ticket_time', 'check_in', 'checkin', 'checkin_time', 'created', 'created_at', 'registered_at'],
  called_at: ['called_at', 'called', 'call_time', 'called_time', 'serving_start', 'start_time', 'service_start', 'started_at'],
  finished_at: ['finished_at', 'finished', 'finish_time', 'end_time', 'service_end', 'completed', 'completed_at', 'closed_at', 'ended_at'],
  service_type: ['service_type', 'service', 'category', 'queue', 'queue_type', 'type', 'department', 'service_line'],
  outcome: ['outcome', 'status', 'result', 'ticket_status'],
  counter_no: ['counter_no', 'counter', 'window', 'desk', 'counter_number'],
  pharmacist: ['pharmacist', 'pharmacist_email', 'staff', 'served_by', 'employee', 'user', 'agent'],
  identified: ['identified', 'has_mrn', 'registered', 'is_identified'],
  patient_ref: ['patient_ref', 'patient_code', 'mrn_hash', 'ref', 'reference'],
};
const ALIAS_INDEX = Object.fromEntries(Object.entries(ALIASES).flatMap(([k, list]) => list.map((a) => [a, k])));

/** Columns that identify a person. They are dropped, never read. */
const SENSITIVE = /^(patient(_full)?_?name|full_name|name|first_name|last_name|patient|mobile|mobile_no|phone|phone_no|telephone|email|patient_email|emirates_id|eid|national_id|passport|passport_no|mrn|mrn_no|file_no|medical_record(_no)?|dob|date_of_birth|address)$/;
const EMIRATES_ID = /\b784[- ]?\d{4}[- ]?\d{7}[- ]?\d\b/;

const SERVICE_ALIASES = {
  prescription: ['prescription', 'rx', 'new_rx', 'new_prescription', 'dispensing', 'pharmacy', 'a'],
  refill: ['refill', 'repeat', 'chronic', 'refill_rx', 'repeat_prescription', 'r'],
  consultation: ['consultation', 'consult', 'counselling', 'counseling', 'advice', 'c'],
  otc: ['otc', 'over_the_counter', 'retail', 'cash', 'o'],
  insurance: ['insurance', 'approval', 'insurance_approval', 'pre_auth', 'preauth', 'i'],
};
const SERVICE_INDEX = Object.fromEntries(Object.entries(SERVICE_ALIASES).flatMap(([k, l]) => l.map((a) => [a, k])));

const OUTCOME_ALIASES = {
  served: ['served', 'completed', 'complete', 'done', 'finished', 'closed', 'served_ok'],
  no_show: ['no_show', 'noshow', 'missed', 'absent', 'not_attended', 'did_not_attend', 'dna'],
  abandoned: ['abandoned', 'left', 'cancelled', 'canceled', 'walked_out', 'left_unseen'],
};
const OUTCOME_INDEX = Object.fromEntries(Object.entries(OUTCOME_ALIASES).flatMap(([k, l]) => l.map((a) => [a, k])));
/** Statuses that only mean "still open"; the timestamps already say that. */
const OPEN_STATUSES = new Set(['serving', 'in_service', 'in_progress', 'called', 'waiting', 'open', 'pending']);

const TRUE = new Set(['1', 'y', 'yes', 'true', 't', 'identified']);
const FALSE = new Set(['0', 'n', 'no', 'false', 'f', 'unidentified']);

// ── date parsing ─────────────────────────────────────────────────
const RE_ISO_TZ = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;
const RE_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i;
const RE_SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i;
const RE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i;
const RE_SERIAL = /^\d{5}(\.\d+)?$/; // Excel serial date, e.g. 45950.4375

const to24 = (h, ampm) => {
  let x = Number(h);
  if (!ampm) return x;
  ampm = ampm.toLowerCase();
  if (ampm === 'pm' && x < 12) x += 12;
  if (ampm === 'am' && x === 12) x = 0;
  return x;
};

/** Decide DD/MM vs MM/DD from the file's own values (UAE default: DD/MM). */
function detectDayFirst(values) {
  let dayFirst = 0;
  let monthFirst = 0;
  let slashDates = 0;
  for (const v of values) {
    const m = RE_SLASH.exec(v);
    if (!m) continue;
    slashDates++;
    if (Number(m[1]) > 12) dayFirst++;
    if (Number(m[2]) > 12) monthFirst++;
  }
  if (monthFirst > dayFirst) return { dayFirst: false, evidence: monthFirst, slashDates };
  return { dayFirst: true, evidence: dayFirst, slashDates };
}

function validParts(p) {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  return (
    d.getUTCFullYear() === p.y && d.getUTCMonth() === p.mo - 1 && d.getUTCDate() === p.d &&
    p.h >= 0 && p.h < 24 && p.mi >= 0 && p.mi < 60 && p.s >= 0 && p.s < 60
  );
}

/**
 * Parse a date-time cell. Returns a Date, null (empty) or 'invalid'.
 * `dateOnly` (YYYY-MM-DD) lets time-only cells combine with a date column.
 */
export function parseDateTime(raw, { tz, dayFirst = true, dateOnly = null } = {}) {
  const v = String(raw ?? '').trim();
  if (!v) return null;

  if (RE_ISO_TZ.test(v)) {
    const d = new Date(v.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? 'invalid' : d;
  }
  let p = null;
  let m;
  if ((m = RE_YMD.exec(v))) {
    p = { y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? to24(m[4], m[7]) : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0 };
  } else if ((m = RE_SLASH.exec(v))) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    p = { y, mo: dayFirst ? b : a, d: dayFirst ? a : b, h: m[4] ? to24(m[4], m[7]) : 0, mi: m[5] ? +m[5] : 0, s: m[6] ? +m[6] : 0 };
  } else if ((m = RE_TIME.exec(v)) && dateOnly) {
    const [y, mo, d] = dateOnly.split('-').map(Number);
    p = { y, mo, d, h: to24(m[1], m[4]), mi: +m[2], s: m[3] ? +m[3] : 0 };
  } else if (RE_SERIAL.test(v)) {
    const serial = Number(v);
    const days = Math.floor(serial);
    const secs = Math.round((serial - days) * 86400);
    const base = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    p = { y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate(), h: Math.floor(secs / 3600), mi: Math.floor((secs % 3600) / 60), s: secs % 60 };
  } else {
    return 'invalid';
  }
  if (!validParts(p)) return 'invalid';
  return localPartsToUtc(p, tz);
}

/** Parse a date-only cell into YYYY-MM-DD (or 'invalid' / null). */
function parseDateOnly(raw, opts) {
  const d = parseDateTime(raw, opts);
  if (d === null || d === 'invalid') return d;
  return localDateISO(d, opts.tz);
}

// ── issue collection ─────────────────────────────────────────────
const ISSUE_TEXT = {
  // errors (row rejected)
  missing_arrival: 'Arrival time is missing',
  bad_date: 'A date/time could not be read',
  called_before_arrival: 'Called before the patient arrived',
  finished_before_called: 'Finished before being called',
  finished_without_call: 'Has a finish time but no call time',
  future_time: 'Time is in the future',
  unknown_branch: 'Branch not recognised',
  branch_not_allowed: 'Branch outside your permission',
  duplicate_in_file: 'Duplicate ticket in this file',
  duplicate_in_db: 'Ticket already imported earlier',
  bad_service: 'Service type not recognised',
  no_show_without_call: 'No-show but never called',
  // warnings (row kept)
  long_wait: 'Wait over 2 hours (possible data error)',
  long_service: 'Service over 45 minutes',
  instant_service: 'Service under 6 seconds (possible accidental click)',
  odd_hour: 'Arrival between 00:00 and 06:00',
  never_closed: 'Called but never closed — kept as auto-closed, excluded from service time',
  left_unseen: 'Never called — kept as left unseen',
  unknown_pharmacist: 'Pharmacist not found — ticket kept without staff link',
  unknown_outcome: 'Outcome not recognised — derived from the timestamps',
  bad_identified: 'Identified value not recognised — assumed identified',
  bad_counter: 'Counter number not recognised — ignored',
  bad_patient_ref: 'Patient reference is not a de-identified code — ignored',
  emirates_id: 'A value looked like an Emirates ID — it was not stored',
};
const ERRORS = new Set(['missing_arrival', 'bad_date', 'called_before_arrival', 'finished_before_called', 'finished_without_call', 'future_time', 'unknown_branch', 'branch_not_allowed', 'duplicate_in_file', 'duplicate_in_db', 'bad_service', 'no_show_without_call']);

class Issues {
  constructor() {
    this.map = new Map();
    this.total = 0;
  }
  add(code, rowNo, example) {
    this.total++;
    let i = this.map.get(code);
    if (!i) {
      i = { code, severity: ERRORS.has(code) ? 'error' : 'warning', message: ISSUE_TEXT[code], count: 0, rows: [], examples: [] };
      this.map.set(code, i);
    }
    i.count++;
    if (i.rows.length < MAX_EXAMPLES) {
      i.rows.push(rowNo);
      if (example !== undefined) i.examples.push(String(example).slice(0, 80));
    }
  }
  list() {
    return [...this.map.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1));
  }
}

const round = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? null : Number(v.toFixed(d)));
const pct = (n, d) => (d > 0 ? round((n / d) * 100, 1) : null);

/** KPIs over validated records using the same definitions as the ticket_metrics view. */
function previewKpis(records) {
  const served = records.filter((r) => r.status === 'served');
  const noShow = records.filter((r) => r.status === 'no_show').length;
  const called = records.filter((r) => r.called_at);
  const waits = called.map((r) => (r.called_at - r.arrived_at) / 60000);
  const services = served.map((r) => (r.finished_at - r.called_at) / 60000);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    totalTickets: records.length,
    served: served.length,
    noShow,
    abandoned: records.filter((r) => r.status === 'abandoned').length,
    autoClosed: records.filter((r) => r.status === 'auto_closed').length,
    serveRate: pct(served.length, served.length + noShow),
    avgWaitMin: round(avg(waits)),
    withinTargetRate: pct(waits.filter((w) => w <= env.WAIT_TARGET_MIN).length, waits.length),
    avgServiceMin: round(avg(services)),
    identifiedRate: pct(records.filter((r) => r.identified).length, records.length),
  };
}

function grade(score) {
  if (score === null) return 'none';
  if (score >= 98) return 'excellent';
  if (score >= 90) return 'good';
  if (score >= 75) return 'fair';
  return 'poor';
}

// ── main validation ──────────────────────────────────────────────
/**
 * Validate a CSV export. Pure analysis except for read-only lookups
 * (branches, pharmacists, already-imported tickets).
 * Returns { report, records } — records are ready to insert.
 */
export async function analyse(csvText, { user, defaultBranchId, fileName = 'upload.csv' }) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw badRequest('The file is empty');
  const tz = env.TIMEZONE;

  // 1. Parse (comma, semicolon or tab; BOM-safe; quoted fields).
  let rows;
  let headers;
  try {
    const parsed = parseCsv(csvText, {
      bom: true,
      delimiter: [',', ';', '\t'],
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });
    if (!parsed.length) throw new Error('empty');
    headers = parsed[0].map((h) => String(h));
    rows = parsed.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  } catch (err) {
    throw badRequest(err.message === 'empty' ? 'The file is empty' : 'The file is not a readable CSV. In Excel use “Save As → CSV UTF-8”.');
  }
  if (!rows.length) throw badRequest('The file has a header row but no data rows');
  if (rows.length > MAX_ROWS) throw badRequest(`The file has ${rows.length.toLocaleString()} rows; the limit per import is ${MAX_ROWS.toLocaleString()}. Split it by month.`);

  // 2. Map columns; drop personal-identifier columns before reading any value.
  const colIndex = {};
  const ignoredSensitive = [];
  const unknownColumns = [];
  headers.forEach((h, i) => {
    const n = norm(h);
    if (SENSITIVE.test(n)) return ignoredSensitive.push(h);
    const key = ALIAS_INDEX[n];
    if (key && colIndex[key] === undefined) colIndex[key] = i;
    else if (!key) unknownColumns.push(h);
  });
  const columns = Object.fromEntries(Object.entries(colIndex).map(([k, i]) => [k, headers[i]]));
  if (colIndex.arrived_at === undefined) {
    throw badRequest('No arrival-time column found. Name it “arrived_at” (or Arrival, Issue Time, Check-in…). See the template.', {
      columnsFound: headers,
    });
  }
  const cell = (r, key) => (colIndex[key] === undefined ? '' : String(r[colIndex[key]] ?? '').trim());

  // 3. Reference data.
  const [{ rows: branches }, { rows: staff }] = await Promise.all([
    query('SELECT id, name FROM falconmed_v4.branches WHERE is_active'),
    query(`SELECT id, email, full_name, branch_id FROM falconmed_v4.users WHERE role = 'pharmacist' AND is_active`),
  ]);
  const branchLookup = new Map();
  for (const b of branches) {
    branchLookup.set(norm(b.id), b);
    branchLookup.set(norm(b.name), b);
  }
  const staffLookup = new Map();
  for (const s of staff) {
    staffLookup.set(`${s.branch_id}|${s.email.toLowerCase()}`, s);
    staffLookup.set(`${s.branch_id}|${norm(s.full_name)}`, s);
  }
  const allowedBranch = user.role === 'admin' ? null : user.branch_id;
  const fallbackBranch = user.role === 'admin' ? defaultBranchId || null : user.branch_id;
  if (fallbackBranch && !branches.some((b) => b.id === fallbackBranch)) throw badRequest('Default branch not found');

  // 4. Day/month order, decided from the whole file.
  const dateCells = [];
  for (const r of rows.slice(0, 5000)) for (const k of ['date', 'arrived_at', 'called_at', 'finished_at']) dateCells.push(cell(r, k));
  const { dayFirst, evidence, slashDates } = detectDayFirst(dateCells.filter(Boolean));
  // Many queue machines export minutes only; then sub-minute durations read as 0 s
  // and the "instant service" check would be noise.
  const hasSeconds = dateCells.some((v) => /\d{1,2}:\d{2}:\d{2}/.test(v) || RE_SERIAL.test(v));

  // 5. Row-by-row validation.
  const issues = new Issues();
  const records = [];
  const seen = new Set();
  const now = Date.now() + 5 * 60_000; // tolerate small clock drift
  let warnedRows = 0;
  let emiratesIdHits = 0;

  rows.forEach((r, i) => {
    const rowNo = i + 2; // header is row 1, as in Excel
    // Privacy: never keep a value that looks like an Emirates ID, wherever it is.
    if (r.some((c) => EMIRATES_ID.test(String(c)))) {
      emiratesIdHits++;
      issues.add('emirates_id', rowNo);
    }
    const before = issues.total;
    const err = (code, ex) => {
      issues.add(code, rowNo, ex);
      return false;
    };

    // Branch
    const branchRaw = cell(r, 'branch');
    const branch = branchRaw ? branchLookup.get(norm(branchRaw)) : branches.find((b) => b.id === fallbackBranch);
    if (!branch) return err('unknown_branch', branchRaw || '(empty — choose a default branch)');
    if (allowedBranch && branch.id !== allowedBranch) return err('branch_not_allowed', branch.name);

    // Times
    const dateOnlyRaw = cell(r, 'date');
    const dateOnly = dateOnlyRaw ? parseDateOnly(dateOnlyRaw, { tz, dayFirst }) : null;
    if (dateOnly === 'invalid') return err('bad_date', dateOnlyRaw);
    const opt = { tz, dayFirst, dateOnly };
    const arrivedRaw = cell(r, 'arrived_at');
    const arrived = parseDateTime(arrivedRaw, opt);
    if (arrived === null) return err('missing_arrival');
    if (arrived === 'invalid') return err('bad_date', arrivedRaw);
    const calledRaw = cell(r, 'called_at');
    const finishedRaw = cell(r, 'finished_at');
    const called = parseDateTime(calledRaw, opt);
    const finished = parseDateTime(finishedRaw, opt);
    if (called === 'invalid') return err('bad_date', calledRaw);
    if (finished === 'invalid') return err('bad_date', finishedRaw);
    if ([arrived, called, finished].some((d) => d && d.getTime() > now)) return err('future_time', finishedRaw || calledRaw || arrivedRaw);
    if (called && called < arrived) return err('called_before_arrival', `${arrivedRaw} → ${calledRaw}`);
    if (finished && !called) return err('finished_without_call', finishedRaw);
    if (finished && called && finished < called) return err('finished_before_called', `${calledRaw} → ${finishedRaw}`);

    // Service type
    const serviceRaw = cell(r, 'service_type');
    const service = serviceRaw ? SERVICE_INDEX[norm(serviceRaw)] : 'prescription';
    if (!service) return err('bad_service', serviceRaw);

    // Outcome → status (timestamps are the source of truth)
    const outcomeRaw = cell(r, 'outcome');
    let outcome = outcomeRaw ? OUTCOME_INDEX[norm(outcomeRaw)] : null;
    if (outcomeRaw && !outcome && !OPEN_STATUSES.has(norm(outcomeRaw))) issues.add('unknown_outcome', rowNo, outcomeRaw);
    let status;
    if (!called) {
      if (outcome === 'no_show') return err('no_show_without_call', outcomeRaw);
      status = 'abandoned';
      issues.add('left_unseen', rowNo);
    } else if (!finished) {
      status = 'auto_closed';
      issues.add('never_closed', rowNo);
    } else {
      status = outcome === 'no_show' ? 'no_show' : 'served';
    }

    // Ticket number + duplicates
    const serviceDate = localDateISO(arrived, tz);
    const ticketNo = cell(r, 'ticket_no').slice(0, 30) || null;
    if (ticketNo) {
      const key = `${branch.id}|${serviceDate}|${ticketNo.toUpperCase()}`;
      if (seen.has(key)) return err('duplicate_in_file', ticketNo);
      seen.add(key);
    }

    // Optional fields
    const pharmacistRaw = cell(r, 'pharmacist');
    let pharmacistId = null;
    if (pharmacistRaw) {
      const s = staffLookup.get(`${branch.id}|${pharmacistRaw.toLowerCase()}`) || staffLookup.get(`${branch.id}|${norm(pharmacistRaw)}`);
      if (s) pharmacistId = s.id;
      else issues.add('unknown_pharmacist', rowNo, pharmacistRaw);
    }
    const counterRaw = cell(r, 'counter_no');
    let counterNo = null;
    if (counterRaw) {
      const c = Number(counterRaw.replace(/[^0-9]/g, ''));
      if (Number.isInteger(c) && c >= 1 && c <= 50) counterNo = c;
      else issues.add('bad_counter', rowNo, counterRaw);
    }
    const idRaw = cell(r, 'identified').toLowerCase();
    let identified = true;
    if (idRaw) {
      if (TRUE.has(idRaw)) identified = true;
      else if (FALSE.has(idRaw)) identified = false;
      else issues.add('bad_identified', rowNo, idRaw);
    }
    const refRaw = cell(r, 'patient_ref');
    let patientRef = null;
    if (refRaw) {
      if (/^[A-Za-z0-9-]{1,40}$/.test(refRaw) && !EMIRATES_ID.test(refRaw)) patientRef = refRaw;
      else issues.add('bad_patient_ref', rowNo);
    }

    // Plausibility warnings (row kept)
    if (called) {
      const wait = (called - arrived) / 60000;
      if (wait > 120) issues.add('long_wait', rowNo, `${Math.round(wait)} min`);
    }
    if (status === 'served') {
      const svc = (finished - called) / 60000;
      if (svc > 45) issues.add('long_service', rowNo, `${Math.round(svc)} min`);
      if (hasSeconds && svc < 0.1) issues.add('instant_service', rowNo, `${Math.round(svc * 60)} s`);
    }
    if (localHour(arrived, tz) < 6) issues.add('odd_hour', rowNo, arrivedRaw);

    if (issues.total > before) warnedRows++;

    records.push({
      rowNo,
      branch_id: branch.id,
      service_date: serviceDate,
      ticket_no: ticketNo,
      service_type: service,
      source: 'import', // the original channel is not trusted across systems
      identified,
      patient_ref: patientRef,
      status,
      arrived_at: arrived,
      called_at: called || null,
      finished_at: finished || null,
      pharmacist_id: pharmacistId,
      counter_no: counterNo,
    });
  });

  // 6. Duplicates against tickets already in the database (one query).
  if (records.some((r) => r.ticket_no)) {
    const dates = records.map((r) => r.service_date).sort();
    const branchIds = [...new Set(records.map((r) => r.branch_id))];
    const { rows: existing } = await query(
      `SELECT branch_id, service_date::text AS d, upper(ticket_no) AS t FROM falconmed_v4.tickets
        WHERE branch_id = ANY($1) AND service_date BETWEEN $2::date AND $3::date`,
      [branchIds, dates[0], dates[dates.length - 1]],
    );
    const inDb = new Set(existing.map((e) => `${e.branch_id}|${e.d}|${e.t}`));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.ticket_no && inDb.has(`${r.branch_id}|${r.service_date}|${r.ticket_no.toUpperCase()}`)) {
        issues.add('duplicate_in_db', r.rowNo, r.ticket_no);
        records.splice(i, 1);
      }
    }
  }

  // 7. Report.
  const total = rows.length;
  const valid = records.length;
  const score = pct(valid, total);
  const dates = records.map((r) => r.service_date).sort();
  const byDayMap = new Map();
  const byBranchMap = new Map();
  for (const r of records) {
    byDayMap.set(r.service_date, (byDayMap.get(r.service_date) || 0) + 1);
    byBranchMap.set(r.branch_id, (byBranchMap.get(r.branch_id) || 0) + 1);
  }
  const report = {
    file: {
      name: fileName,
      rows: total,
      columns,
      ignoredSensitive,
      unknownColumns,
      dateOrder: slashDates === 0 ? 'YYYY-MM-DD' : dayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY',
      dateOrderEvidence: evidence,
      timePrecision: hasSeconds ? 'seconds' : 'minutes',
      timezone: tz,
    },
    summary: {
      total,
      valid,
      rejected: total - valid,
      rowsWithWarnings: warnedRows,
      score,
      grade: grade(score),
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
      days: byDayMap.size,
      branches: [...byBranchMap.entries()].map(([id, rowsN]) => ({ id, name: branches.find((b) => b.id === id)?.name, rows: rowsN })),
      noPharmacistLinked: records.filter((r) => !r.pharmacist_id).length,
      emiratesIdValuesDropped: emiratesIdHits,
    },
    issues: issues.list(),
    preview: previewKpis(records),
    byDay: [...byDayMap.entries()].sort().map(([date, tickets]) => ({ date, tickets })),
    canImport: valid > 0,
  };
  return { report, records };
}

// ── commit ───────────────────────────────────────────────────────
const COLS = [
  ['branch_id', 'text'], ['service_date', 'date'], ['ticket_no', 'text'], ['service_type', 'text'],
  ['source', 'text'], ['identified', 'boolean'], ['patient_ref', 'text'], ['status', 'text'],
  ['arrived_at', 'timestamptz'], ['called_at', 'timestamptz'], ['finished_at', 'timestamptz'],
  ['pharmacist_id', 'text'], ['counter_no', 'smallint'], ['import_batch_id', 'bigint'],
];

export async function commitImport(csvText, { user, defaultBranchId, fileName }) {
  const { report, records } = await analyse(csvText, { user, defaultBranchId, fileName });
  if (!records.length) throw badRequest('No valid rows to import', { report });

  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO falconmed_v4.import_batches
         (created_by, file_name, branch_ids, rows_total, rows_imported, rows_rejected, quality_score, date_from, date_to, report)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at`,
      [
        user.id, String(fileName).slice(0, 200), report.summary.branches.map((b) => b.id), report.summary.total,
        report.summary.valid, report.summary.rejected, report.summary.score, report.summary.dateFrom,
        report.summary.dateTo, JSON.stringify({ summary: report.summary, issues: report.issues, file: report.file }),
      ],
    );
    const batchId = Number(rows[0].id);
    for (const r of records) {
      r.import_batch_id = batchId;
      if (!r.ticket_no) r.ticket_no = `IMP${batchId}-${r.rowNo}`;
    }
    const CHUNK = 4000;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      await c.query(
        `INSERT INTO falconmed_v4.tickets (${COLS.map(([k]) => k).join(', ')})
         SELECT * FROM unnest(${COLS.map(([, t], j) => `$${j + 1}::${t}[]`).join(', ')})`,
        COLS.map(([k]) => chunk.map((r) => r[k])),
      );
    }
    return { batchId, createdAt: rows[0].created_at, report };
  });
}

// ── history / rollback ───────────────────────────────────────────
export async function listBatches(user) {
  const params = [];
  let filter = '';
  if (user.role !== 'admin') {
    params.push(user.branch_id);
    filter = 'WHERE $1 = ALL(b.branch_ids)';
  }
  const { rows } = await query(
    `SELECT b.id, b.file_name, b.branch_ids, b.rows_total, b.rows_imported, b.rows_rejected, b.quality_score,
            b.date_from::text, b.date_to::text, b.created_at, u.full_name AS created_by
       FROM falconmed_v4.import_batches b JOIN falconmed_v4.users u ON u.id = b.created_by
       ${filter}
   ORDER BY b.created_at DESC LIMIT 50`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    fileName: r.file_name,
    branchIds: r.branch_ids,
    rowsTotal: r.rows_total,
    rowsImported: r.rows_imported,
    rowsRejected: r.rows_rejected,
    qualityScore: r.quality_score,
    dateFrom: r.date_from,
    dateTo: r.date_to,
    createdAt: r.created_at,
    createdBy: r.created_by,
  }));
}

/** Remove an import and all of its tickets (ON DELETE CASCADE). */
export async function deleteBatch(user, id) {
  const params = [id];
  let filter = '';
  if (user.role !== 'admin') {
    params.push(user.branch_id);
    filter = 'AND $2 = ALL(branch_ids)';
  }
  const { rows } = await query(`DELETE FROM falconmed_v4.import_batches WHERE id = $1 ${filter} RETURNING id, rows_imported`, params);
  return rows[0] ? { id: Number(rows[0].id), rowsRemoved: rows[0].rows_imported } : null;
}
