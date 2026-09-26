BEGIN;
CREATE TABLE mlg_bot.member_blocks (
 user_id text PRIMARY KEY REFERENCES mlg_bot.users(id),
 blocked_by text NOT NULL REFERENCES mlg_bot.users(id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 160),
 blocked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mlg_bot.member_block_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id text NOT NULL REFERENCES mlg_bot.users(id),
 target_id text NOT NULL REFERENCES mlg_bot.users(id),
 action text NOT NULL CHECK(action IN ('block','unblock')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 8 AND 160),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON mlg_bot.member_blocks FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON mlg_bot.member_block_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON mlg_bot.member_blocks TO mlg_bot_gateway;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mlg_bot_app') THEN
  GRANT SELECT ON mlg_bot.member_blocks TO mlg_bot_app;
 END IF;
END $$;
GRANT SELECT, INSERT ON mlg_bot.member_block_events TO mlg_bot_gateway;
GRANT USAGE, SELECT ON SEQUENCE mlg_bot.member_block_events_id_seq TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
COMMIT;
