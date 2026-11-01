-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v5.0 — security review follow-ups
-- Failed sign-ins expire after the lock window, and the IP of the last
-- successful sign-in lets the owner in while strangers keep the account locked.
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip TEXT;
