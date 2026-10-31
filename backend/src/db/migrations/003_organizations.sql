-- ═══════════════════════════════════════════════════════════════
-- FalconMed Elite v4.4 — organisations (multi-tenancy)
-- One platform, many pharmacy groups. Every branch, user and import
-- belongs to exactly one organisation, and every query is filtered
-- by the signed-in user's organisation on the server.
-- Existing data is moved into the demo organisation; nothing is lost.
-- ═══════════════════════════════════════════════════════════════

SET search_path TO falconmed_v4, public;

CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,                 -- e.g. 'org_demo'
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  plan        TEXT NOT NULL DEFAULT 'trial'
              CHECK (plan IN ('demo', 'trial', 'starter', 'pro', 'enterprise')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name, slug, plan)
VALUES ('org_demo', 'FalconMed Demo Network', 'demo', 'demo')
ON CONFLICT (id) DO NOTHING;

-- branches ────────────────────────────────────────────────────────
ALTER TABLE branches ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
UPDATE branches SET org_id = 'org_demo' WHERE org_id IS NULL;
ALTER TABLE branches ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS branches_org_idx ON branches (org_id);
-- Lets other tables prove that a branch belongs to their organisation.
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_id_org_key;
ALTER TABLE branches ADD CONSTRAINT branches_id_org_key UNIQUE (id, org_id);

-- users ───────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
UPDATE users SET org_id = 'org_demo' WHERE org_id IS NULL;
ALTER TABLE users ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS users_org_idx ON users (org_id);
-- A user's branch must belong to the user's own organisation.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_branch_same_org;
ALTER TABLE users ADD CONSTRAINT users_branch_same_org
  FOREIGN KEY (branch_id, org_id) REFERENCES branches (id, org_id);

-- import batches ──────────────────────────────────────────────────
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
UPDATE import_batches SET org_id = 'org_demo' WHERE org_id IS NULL;
ALTER TABLE import_batches ALTER COLUMN org_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS import_batches_org_idx ON import_batches (org_id, created_at DESC);

-- Tickets need no column of their own: a ticket belongs to its branch,
-- and the branch belongs to one organisation.
