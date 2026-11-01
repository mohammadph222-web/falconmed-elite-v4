-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v5.0 — two-factor sign-in and shared rate limits
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

-- Authenticator-app (TOTP) two-factor sign-in. The secret is stored encrypted
-- (AES-256-GCM); recovery codes are stored as SHA-256 hashes and used once.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at   TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step    BIGINT;       -- last accepted code, so it cannot be replayed
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes    TEXT[] NOT NULL DEFAULT '{}';

-- Organisations can require two-factor sign-in for their admins.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS require_admin_2fa BOOLEAN NOT NULL DEFAULT FALSE;

-- Counters for the sign-in, sign-up and email rate limits, shared by every API instance.
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  hits      INTEGER NOT NULL,
  reset_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);
