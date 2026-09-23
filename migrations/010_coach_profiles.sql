BEGIN;
CREATE TABLE IF NOT EXISTS mlg_bot.coach_profiles (
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 user_id text NOT NULL REFERENCES mlg_bot.users(id),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 60),
 PRIMARY KEY(group_id,user_id)
);
REVOKE ALL ON mlg_bot.coach_profiles FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON mlg_bot.coach_profiles TO mlg_bot_gateway;
ALTER TABLE mlg_bot.audit_logs ALTER COLUMN cup_id DROP NOT NULL;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
COMMIT;
