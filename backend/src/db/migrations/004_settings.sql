-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v4.5 — organisation settings
-- Organisation admins manage their own branches and team from the
-- app. Supports temporary passwords, sign-out on password change,
-- and protected records in demo organisations.
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

-- Accounts created or reset by an admin get a temporary password and
-- must choose their own at the next sign-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
-- Carried in every session token. Raising it (password change or reset)
-- signs out every session issued before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Records created by the demo seed. Visitors to the public demo can add
-- their own branches and staff, but cannot change or lock these.
ALTER TABLE users    ADD COLUMN IF NOT EXISTS is_demo_fixture BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_demo_fixture BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users    SET is_demo_fixture = TRUE WHERE org_id IN (SELECT id FROM organizations WHERE plan = 'demo');
UPDATE branches SET is_demo_fixture = TRUE WHERE org_id IN (SELECT id FROM organizations WHERE plan = 'demo');

-- Emails are compared case-insensitively.
UPDATE users SET email = lower(email) WHERE email <> lower(email);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_lowercase;
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));

-- One active pharmacist per counter in a branch.
CREATE UNIQUE INDEX IF NOT EXISTS users_one_pharmacist_per_counter
  ON users (branch_id, counter_no) WHERE role = 'pharmacist' AND is_active;

-- Counters are numbered 1..branch.counters.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_counter_positive;
ALTER TABLE users ADD CONSTRAINT users_counter_positive CHECK (counter_no IS NULL OR counter_no BETWEEN 1 AND 50);
