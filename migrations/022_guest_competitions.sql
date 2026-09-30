BEGIN;
CREATE TABLE mlg_bot.guest_competitions (
 id text PRIMARY KEY,
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 3 AND 60),
 mode text NOT NULL CHECK(mode IN ('liga','copa')),
 legs smallint NOT NULL CHECK(legs IN (1,2)),
 size smallint NOT NULL CHECK(size BETWEEN 2 AND 16 OR mode='copa' AND size=32),
 status text NOT NULL CHECK(status IN ('open','playing','completed','cancelled')),
 created_at bigint NOT NULL,
 champion_id text REFERENCES mlg_bot.users(id),
 completed_at bigint,
 CHECK ((status='completed')=(champion_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX guest_one_active ON mlg_bot.guest_competitions(group_id) WHERE status IN ('open','playing');
CREATE INDEX guest_history ON mlg_bot.guest_competitions(group_id,created_at DESC);
CREATE TABLE mlg_bot.guest_players (
 cup_id text NOT NULL REFERENCES mlg_bot.guest_competitions(id),
 user_id text NOT NULL REFERENCES mlg_bot.users(id),
 display_name text NOT NULL,
 team text NOT NULL,
 position smallint NOT NULL,
 PRIMARY KEY(cup_id,user_id), UNIQUE(cup_id,team), UNIQUE(cup_id,position)
);
CREATE TABLE mlg_bot.guest_matches (
 code bigint PRIMARY KEY,
 cup_id text NOT NULL REFERENCES mlg_bot.guest_competitions(id),
 round smallint NOT NULL,
 position smallint NOT NULL,
 leg smallint NOT NULL CHECK(leg IN (1,2,3)),
 home text NOT NULL REFERENCES mlg_bot.users(id),
 away text NOT NULL REFERENCES mlg_bot.users(id),
 status text NOT NULL CHECK(status IN ('scheduled','pending','disputed','confirmed')),
 home_score smallint CHECK(home_score BETWEEN 0 AND 99),
 away_score smallint CHECK(away_score BETWEEN 0 AND 99),
 author text REFERENCES mlg_bot.users(id),
 reported_at bigint,
 confirmed_by text REFERENCES mlg_bot.users(id),
 CHECK(home<>away),
 CHECK ((status='confirmed')=(confirmed_by IS NOT NULL)),
 UNIQUE(cup_id,round,position,leg)
);
CREATE INDEX guest_match_cup ON mlg_bot.guest_matches(cup_id,round,position,leg);
CREATE TABLE mlg_bot.guest_result_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 cup_id text NOT NULL REFERENCES mlg_bot.guest_competitions(id),
 code bigint NOT NULL REFERENCES mlg_bot.guest_matches(code),
 actor text NOT NULL REFERENCES mlg_bot.users(id),
 action text NOT NULL,
 before_score text,
 after_score text,
 reason text,
 at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON mlg_bot.guest_competitions,mlg_bot.guest_players,mlg_bot.guest_matches,mlg_bot.guest_result_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON mlg_bot.guest_competitions,mlg_bot.guest_players,mlg_bot.guest_matches,mlg_bot.guest_result_audit TO mlg_bot_gateway;
GRANT USAGE,SELECT ON SEQUENCE mlg_bot.guest_result_audit_id_seq TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(22) ON CONFLICT DO NOTHING;
COMMIT;
