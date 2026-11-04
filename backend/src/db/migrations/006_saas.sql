-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v5.0 — production SaaS
--   • per-organisation queue API keys (replaces the shared key)
--   • account lockout, email verification and password reset
--   • audit log of security-relevant actions
--   • Stripe subscriptions and plan enforcement
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

-- ── queue API keys ───────────────────────────────────────────────
-- One organisation's kiosk can only ever reach that organisation's
-- branches (optionally one branch). Only a SHA-256 hash is stored;
-- the full key is shown once, when it is created.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,                       -- 'key_…'
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  branch_id     TEXT,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,                          -- first characters, to recognise a key
  key_hash      TEXT NOT NULL UNIQUE,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT api_keys_branch_same_org FOREIGN KEY (branch_id, org_id) REFERENCES branches (id, org_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);

-- ── sign-in protection and email ─────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
-- Existing accounts were created by an admin or the seed: treat them as verified.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- Single-use links sent by email. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('password_reset', 'verify_email')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id, purpose);

-- ── audit log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,                            -- e.g. 'user.create', 'auth.login_failed'
  target      TEXT,
  ip          TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, created_at DESC);

-- ── billing ──────────────────────────────────────────────────────
-- plan:                what the organisation is entitled to
-- subscription_status: Stripe's status, kept in sync by the webhook
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT UNIQUE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status    TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS current_period_end     TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at             TIMESTAMPTZ;

-- Webhook deliveries already processed (Stripe retries and may send twice).
CREATE TABLE IF NOT EXISTS stripe_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
