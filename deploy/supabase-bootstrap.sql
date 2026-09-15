CREATE SCHEMA IF NOT EXISTS mlg_bot;
REVOKE ALL ON SCHEMA mlg_bot FROM PUBLIC;
SET LOCAL search_path TO mlg_bot, pg_catalog;

CREATE TABLE users (id text PRIMARY KEY, display_name text NOT NULL);
CREATE TABLE wa_identities (
  jid text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE groups (
  id text PRIMARY KEY, authorized boolean NOT NULL DEFAULT false
);
CREATE TABLE admins (
  group_id text NOT NULL REFERENCES groups(id), user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin')),
  PRIMARY KEY(group_id,user_id)
);
CREATE TABLE club_pool (
  group_id text NOT NULL REFERENCES groups(id), name text NOT NULL CHECK (length(trim(name)) > 0),
  PRIMARY KEY(group_id,name)
);
CREATE TABLE command_drafts (
  group_id text PRIMARY KEY REFERENCES groups(id), owner_id text NOT NULL REFERENCES users(id),
  expires_at bigint NOT NULL
);
CREATE TABLE counters (id text PRIMARY KEY, next_code bigint NOT NULL CHECK(next_code > 0));
INSERT INTO counters VALUES ('match',100);
CREATE TABLE cups (
  id text PRIMARY KEY, group_id text NOT NULL REFERENCES groups(id),
  created_by text NOT NULL REFERENCES users(id), created_at bigint NOT NULL,
  size integer NOT NULL CHECK (size IN (4,8,16)),
  status text NOT NULL CHECK(status IN ('open','playing','completed','cancelled')),
  champion text REFERENCES users(id), completed_at bigint, cancellation_reason text,
  CHECK ((status='completed' AND champion IS NOT NULL AND completed_at IS NOT NULL)
    OR (status<>'completed' AND champion IS NULL AND completed_at IS NULL)),
  UNIQUE (id,group_id)
);
CREATE UNIQUE INDEX one_active_cup_per_group ON cups(group_id) WHERE status IN ('open','playing');
CREATE TABLE cup_participants (
  cup_id text NOT NULL REFERENCES cups(id), user_id text NOT NULL REFERENCES users(id),
  display_name text NOT NULL, position integer NOT NULL CHECK(position >= 0), club text,
  PRIMARY KEY(cup_id,user_id), UNIQUE(cup_id,position), UNIQUE(cup_id,club)
);
ALTER TABLE cups ADD CONSTRAINT champion_in_cup FOREIGN KEY(id,champion) REFERENCES cup_participants(cup_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE matches (
  code bigint PRIMARY KEY, cup_id text NOT NULL REFERENCES cups(id),
  round integer NOT NULL CHECK(round >= 0), position integer NOT NULL CHECK(position >= 0),
  home text NOT NULL, away text NOT NULL, winner text,
  status text NOT NULL CHECK(status IN ('scheduled','pending','disputed','confirmed')),
  CHECK(home <> away), CHECK(winner IS NULL OR winner IN (home,away)),
  CHECK((status='confirmed') = (winner IS NOT NULL)),
  FOREIGN KEY(cup_id,home) REFERENCES cup_participants(cup_id,user_id),
  FOREIGN KEY(cup_id,away) REFERENCES cup_participants(cup_id,user_id),
  UNIQUE(cup_id,round,position)
);
CREATE TABLE match_results (
  match_code bigint NOT NULL REFERENCES matches(code), revision integer NOT NULL CHECK(revision > 0),
  home integer NOT NULL CHECK(home BETWEEN 0 AND 99), away integer NOT NULL CHECK(away BETWEEN 0 AND 99),
  author text NOT NULL REFERENCES users(id), created_at bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','disputed','confirmed')),
  confirmed_by text REFERENCES users(id), disputed_by text REFERENCES users(id), reason text,
  CHECK(home <> away), CHECK(confirmed_by IS DISTINCT FROM author OR coalesce(length(reason) >= 8,false)),
  CHECK((status='confirmed') = (confirmed_by IS NOT NULL)),
  PRIMARY KEY(match_code,revision)
);
CREATE TABLE processed_messages (
  group_id text NOT NULL REFERENCES groups(id), user_id text NOT NULL REFERENCES users(id),
  message_id text NOT NULL, received_at bigint NOT NULL,
  PRIMARY KEY(group_id,user_id,message_id)
);
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL REFERENCES users(id), group_id text NOT NULL REFERENCES groups(id),
  cup_id text NOT NULL REFERENCES cups(id), match_code bigint REFERENCES matches(code),
  occurred_at bigint NOT NULL, action text NOT NULL, before_state jsonb, after_state jsonb,
  outcome text NOT NULL CHECK(outcome IN ('accepted','rejected'))
);
CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id text NOT NULL REFERENCES groups(id), user_id text NOT NULL REFERENCES users(id),
  message_id text NOT NULL, ordinal integer NOT NULL, body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, sent_at timestamptz,
  UNIQUE(group_id,user_id,message_id,ordinal),
  FOREIGN KEY(group_id,user_id,message_id) REFERENCES processed_messages(group_id,user_id,message_id)
);
CREATE INDEX outbox_pending ON outbox(available_at,id) WHERE status IN ('pending','sending');
CREATE INDEX cups_group_history ON cups(group_id,created_at DESC);
CREATE INDEX participant_user ON cup_participants(user_id);
CREATE INDEX matches_cup ON matches(cup_id);
CREATE INDEX audit_group_time ON audit_logs(group_id,occurred_at DESC);

CREATE TABLE wa_auth (
  account_id text NOT NULL, category text NOT NULL, key_id text NOT NULL,
  key_version integer NOT NULL, nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
  auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16), ciphertext bytea NOT NULL,
  PRIMARY KEY(account_id,category,key_id)
);
CREATE TABLE banter_memories (
  id text PRIMARY KEY, group_id text NOT NULL REFERENCES groups(id),
  kind text NOT NULL CHECK(kind IN ('alias','rivalry','joke')),
  body text NOT NULL, source text NOT NULL CHECK(length(source)>0),
  status text NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','approved','rejected')),
  reviewed_by text REFERENCES users(id),
  CHECK((status='candidate') = (reviewed_by IS NULL))
);
CREATE TABLE memory_subjects (
  memory_id text NOT NULL REFERENCES banter_memories(id), user_id text NOT NULL REFERENCES users(id),
  PRIMARY KEY(memory_id,user_id)
);
CREATE TABLE conversation_context (
  group_id text NOT NULL REFERENCES groups(id), message_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id), excerpt text NOT NULL CHECK(length(excerpt)<=500),
  expires_at timestamptz NOT NULL, PRIMARY KEY(group_id,message_id)
);
CREATE INDEX context_expiry ON conversation_context(expires_at);
CREATE TABLE bot_settings (
  group_id text PRIMARY KEY REFERENCES groups(id),
  banter_level text NOT NULL DEFAULT 'NORMAL' CHECK(banter_level IN ('LEVE','NORMAL','PESADA')),
  spontaneous boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'America/Cuiaba'
);
REVOKE ALL ON ALL TABLES IN SCHEMA mlg_bot FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mlg_bot FROM PUBLIC;
CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES (1);
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

REVOKE ALL ON SCHEMA mlg_bot FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA mlg_bot FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mlg_bot FROM PUBLIC, anon, authenticated, service_role;
