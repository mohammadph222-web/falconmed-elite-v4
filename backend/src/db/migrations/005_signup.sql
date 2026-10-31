-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v4.6 — self-service sign-up and free trial
-- A pharmacy can create its own organisation from the website and
-- start a free trial without anyone setting it up for them.
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
-- How the organisation was created: 'signup' (website), 'admin' (set up by us), 'seed' (demo).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'admin'
  CHECK (created_via IN ('signup', 'admin', 'seed'));
UPDATE organizations SET created_via = 'seed' WHERE plan = 'demo';
