-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v4 — core schema
-- Lives in its own schema so it never collides with v3 tables
-- (patient_logs, transactions, …) in the same Neon database.
-- No patient names are stored: a ticket carries an optional
-- de-identified patient reference only.
-- ═══════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS falconmed_v4;
SET search_path TO falconmed_v4, public;

CREATE TABLE IF NOT EXISTS branches (
  id          TEXT PRIMARY KEY,                 -- e.g. 'br_ad01'
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  counters    SMALLINT NOT NULL DEFAULT 4 CHECK (counters BETWEEN 1 AND 50),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- e.g. 'u_ph_ad01_1'
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('pharmacist', 'manager', 'admin')),
  branch_id     TEXT REFERENCES branches(id),
  counter_no    SMALLINT,
  password_hash TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_branch_required CHECK (role = 'admin' OR branch_id IS NOT NULL),
  CONSTRAINT users_counter_for_pharmacist CHECK (role = 'pharmacist' OR counter_no IS NULL)
);

CREATE TABLE IF NOT EXISTS tickets (
  id            BIGSERIAL PRIMARY KEY,
  branch_id     TEXT NOT NULL REFERENCES branches(id),
  service_date  DATE NOT NULL,                  -- business date in the configured timezone
  ticket_no     TEXT NOT NULL,                  -- e.g. 'A-042', unique per branch per day
  service_type  TEXT NOT NULL DEFAULT 'prescription'
                CHECK (service_type IN ('prescription', 'refill', 'consultation', 'otc', 'insurance')),
  source        TEXT NOT NULL DEFAULT 'kiosk'
                CHECK (source IN ('kiosk', 'mobile', 'walk_in', 'simulator')),
  identified    BOOLEAN NOT NULL DEFAULT TRUE,  -- patient matched to a medical record
  patient_ref   TEXT,                           -- de-identified reference, never a name
  status        TEXT NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'in_service', 'served', 'no_show', 'abandoned', 'auto_closed')),
  arrived_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_at     TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  pharmacist_id TEXT REFERENCES users(id),
  counter_no    SMALLINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tickets_unique_no UNIQUE (branch_id, service_date, ticket_no),
  CONSTRAINT tickets_called_after_arrival CHECK (called_at IS NULL OR called_at >= arrived_at),
  CONSTRAINT tickets_finished_after_called CHECK (finished_at IS NULL OR (called_at IS NOT NULL AND finished_at >= called_at)),
  CONSTRAINT tickets_status_consistency CHECK (
       (status = 'waiting'    AND called_at IS NULL     AND finished_at IS NULL)
    OR (status = 'in_service' AND called_at IS NOT NULL AND finished_at IS NULL AND pharmacist_id IS NOT NULL)
    OR (status IN ('served', 'no_show') AND called_at IS NOT NULL AND finished_at IS NOT NULL AND pharmacist_id IS NOT NULL)
    -- end-of-day housekeeping (see services/queue.js → closeStaleTickets):
    OR (status = 'abandoned'   AND called_at IS NULL     AND finished_at IS NULL)   -- left before being called
    OR (status = 'auto_closed' AND called_at IS NOT NULL AND finished_at IS NULL AND pharmacist_id IS NOT NULL) -- never closed at the counter
  )
);

CREATE INDEX IF NOT EXISTS tickets_branch_date_idx   ON tickets (branch_id, service_date);
CREATE INDEX IF NOT EXISTS tickets_date_idx          ON tickets (service_date);
CREATE INDEX IF NOT EXISTS tickets_pharmacist_idx    ON tickets (pharmacist_id, service_date);
CREATE INDEX IF NOT EXISTS tickets_open_idx          ON tickets (branch_id, arrived_at) WHERE status IN ('waiting', 'in_service');
-- At most one open ticket per pharmacist at a time.
CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_open_per_pharmacist
  ON tickets (pharmacist_id) WHERE status = 'in_service';

-- ───────────────────────────────────────────────────────────────
-- The single source of truth for every KPI.
-- Every dashboard, endpoint and export reads these columns, so a
-- metric means the same thing everywhere.
--   wait_min        = called_at  − arrived_at   (time in queue)
--   service_min     = finished_at − called_at   (time at counter; served only)
--   turnaround_min  = finished_at − arrived_at  (served only)
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ticket_metrics AS
SELECT
  t.*,
  EXTRACT(EPOCH FROM (t.called_at - t.arrived_at)) / 60.0                       AS wait_min,
  CASE WHEN t.status = 'served'
       THEN EXTRACT(EPOCH FROM (t.finished_at - t.called_at)) / 60.0 END         AS service_min,
  CASE WHEN t.status = 'served'
       THEN EXTRACT(EPOCH FROM (t.finished_at - t.arrived_at)) / 60.0 END        AS turnaround_min
FROM tickets t;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
