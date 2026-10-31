-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v4.3 — data import
-- Lets a pharmacy load an export from its own queue system (CSV),
-- after a data-quality check. Every import is a batch that can be
-- rolled back in one step.
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

CREATE TABLE IF NOT EXISTS import_batches (
  id             BIGSERIAL PRIMARY KEY,
  created_by     TEXT NOT NULL REFERENCES users(id),
  file_name      TEXT NOT NULL,
  branch_ids     TEXT[] NOT NULL DEFAULT '{}',
  rows_total     INTEGER NOT NULL,
  rows_imported  INTEGER NOT NULL,
  rows_rejected  INTEGER NOT NULL,
  quality_score  NUMERIC(5,1),
  date_from      DATE,
  date_to        DATE,
  report         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS import_batch_id BIGINT
  REFERENCES import_batches(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS tickets_import_batch_idx ON tickets (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- Imported tickets carry source = 'import'.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_source_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_source_check
  CHECK (source IN ('kiosk', 'mobile', 'walk_in', 'simulator', 'import'));

-- Exports from other systems often do not say which pharmacist served
-- the patient, so imported tickets may have no pharmacist. Live tickets
-- still always require one.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_consistency;
ALTER TABLE tickets ADD CONSTRAINT tickets_status_consistency CHECK (
     (status = 'waiting'    AND called_at IS NULL     AND finished_at IS NULL)
  OR (status = 'in_service' AND called_at IS NOT NULL AND finished_at IS NULL AND pharmacist_id IS NOT NULL)
  OR (status IN ('served', 'no_show') AND called_at IS NOT NULL AND finished_at IS NOT NULL
      AND (pharmacist_id IS NOT NULL OR source = 'import'))
  OR (status = 'abandoned'   AND called_at IS NULL     AND finished_at IS NULL)
  OR (status = 'auto_closed' AND called_at IS NOT NULL AND finished_at IS NULL
      AND (pharmacist_id IS NOT NULL OR source = 'import'))
);

-- The view selects t.*, so it must be rebuilt to include the new column.
DROP VIEW IF EXISTS ticket_metrics;
CREATE VIEW ticket_metrics AS
SELECT
  t.*,
  EXTRACT(EPOCH FROM (t.called_at - t.arrived_at)) / 60.0                       AS wait_min,
  CASE WHEN t.status = 'served'
       THEN EXTRACT(EPOCH FROM (t.finished_at - t.called_at)) / 60.0 END         AS service_min,
  CASE WHEN t.status = 'served'
       THEN EXTRACT(EPOCH FROM (t.finished_at - t.arrived_at)) / 60.0 END        AS turnaround_min
FROM tickets t;

-- A sandbox branch for trying the importer without mixing with live branches.
INSERT INTO branches (id, name, city, counters)
VALUES ('br_lab', 'Data Import Lab', 'Sandbox', 4)
ON CONFLICT (id) DO NOTHING;
