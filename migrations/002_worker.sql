BEGIN;
CREATE TABLE mlg_bot.inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id text NOT NULL REFERENCES mlg_bot.groups(id),
  user_id text NOT NULL REFERENCES mlg_bot.users(id),
  message_id text NOT NULL, display_name text NOT NULL, body text NOT NULL CHECK(length(body)<=1000),
  received_at bigint NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','rejected')),
  UNIQUE(group_id,user_id,message_id)
);
CREATE INDEX inbox_pending ON mlg_bot.inbox(id) WHERE status='pending';
CREATE TABLE mlg_bot.command_rate (
  group_id text NOT NULL, user_id text NOT NULL, window_start timestamptz NOT NULL,
  count integer NOT NULL, PRIMARY KEY(group_id,user_id)
);
CREATE TABLE mlg_bot.control_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(), action text NOT NULL,
  group_id text, user_id text
);
ALTER TABLE mlg_bot.outbox ADD COLUMN wa_message_id text;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(2);
COMMIT;
