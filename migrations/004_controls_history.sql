BEGIN;
ALTER TABLE mlg_bot.groups ADD COLUMN IF NOT EXISTS admins_configured boolean NOT NULL DEFAULT false;
ALTER TABLE mlg_bot.bot_settings ADD COLUMN IF NOT EXISTS resenha_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE mlg_bot.bot_settings ADD COLUMN IF NOT EXISTS history_enabled boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS mlg_bot.history_entries (
 id text PRIMARY KEY, source text NOT NULL, message_date text NOT NULL,
 body text NOT NULL CHECK(length(body) BETWEEN 20 AND 500),
 search tsvector GENERATED ALWAYS AS (to_tsvector('portuguese',body)) STORED
);
CREATE INDEX IF NOT EXISTS history_search ON mlg_bot.history_entries USING gin(search);
CREATE TABLE IF NOT EXISTS mlg_bot.history_reviews (
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 entry_id text NOT NULL REFERENCES mlg_bot.history_entries(id),
 approved boolean NOT NULL, reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(group_id,entry_id)
);
GRANT SELECT,INSERT,UPDATE ON mlg_bot.bot_settings,mlg_bot.history_entries,mlg_bot.history_reviews TO mlg_bot_gateway;
GRANT DELETE ON mlg_bot.admins TO mlg_bot_gateway;
REVOKE ALL ON mlg_bot.history_entries,mlg_bot.history_reviews FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
COMMIT;
