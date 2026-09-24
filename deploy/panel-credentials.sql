-- Historical migration applied as panel_credentials_rotation_v2.
-- The Render deployment has no DATABASE_URL, so current password rotation uses
-- a separate private object in the authenticated session vault instead.
-- This table is unused; retain the migration as a record of the schema change.
CREATE TABLE IF NOT EXISTS mlg_bot.panel_credentials (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{32}$'),
 digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
 changed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON mlg_bot.panel_credentials FROM PUBLIC, anon, authenticated;
ALTER TABLE mlg_bot.panel_credentials ENABLE ROW LEVEL SECURITY;
