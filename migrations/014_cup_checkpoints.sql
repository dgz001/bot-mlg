BEGIN;
CREATE TABLE mlg_bot.cup_checkpoints (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 group_id text NOT NULL REFERENCES mlg_bot.groups(id),
 cup_id text NOT NULL REFERENCES mlg_bot.cups(id),
 actor_id text NOT NULL REFERENCES mlg_bot.users(id),
 event_id text NOT NULL,
 recorded_at bigint NOT NULL,
 state jsonb NOT NULL,
 sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 UNIQUE (cup_id,actor_id,event_id)
);
CREATE INDEX cup_checkpoints_latest ON mlg_bot.cup_checkpoints(cup_id,id DESC);
REVOKE ALL ON mlg_bot.cup_checkpoints FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON mlg_bot.cup_checkpoints TO mlg_bot_gateway;
GRANT USAGE,SELECT ON SEQUENCE mlg_bot.cup_checkpoints_id_seq TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;
COMMIT;
