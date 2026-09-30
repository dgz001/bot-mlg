BEGIN;
CREATE TABLE mlg_bot.loan_groups (
 group_id text PRIMARY KEY REFERENCES mlg_bot.groups(id),
 manager_id text NOT NULL REFERENCES mlg_bot.users(id),
 granted_by text NOT NULL REFERENCES mlg_bot.users(id),
 active boolean NOT NULL DEFAULT true,
 granted_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE TABLE mlg_bot.loan_champions (
 cup_id text PRIMARY KEY,
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 champion_id text NOT NULL REFERENCES mlg_bot.users(id),
 champion_name text NOT NULL,
 competition_name text NOT NULL,
 edition integer NOT NULL CHECK(edition > 0),
 completed_at bigint NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_champions_group_time ON mlg_bot.loan_champions(group_id,completed_at DESC);
REVOKE ALL ON mlg_bot.loan_groups,mlg_bot.loan_champions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON mlg_bot.loan_groups TO mlg_bot_gateway;
GRANT SELECT,INSERT ON mlg_bot.loan_champions TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
COMMIT;
