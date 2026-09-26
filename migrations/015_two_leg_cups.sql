BEGIN;
-- Existing editions and saved models continue using their original one-game
-- rules. Mode is copied onto a Cup at creation and never changed mid-edition.
ALTER TABLE mlg_bot.groups ADD COLUMN play_mode text NOT NULL DEFAULT 'single'
  CHECK (play_mode IN ('single','home-and-away'));
ALTER TABLE mlg_bot.competition_templates ADD COLUMN play_mode text NOT NULL DEFAULT 'single'
  CHECK (play_mode IN ('single','home-and-away'));
ALTER TABLE mlg_bot.cups ADD COLUMN play_mode text NOT NULL DEFAULT 'single'
  CHECK (play_mode IN ('single','home-and-away'));

-- The match row remains the durable tie and bracket slot. Leg 1 belongs to
-- its home player; leg 2 reverses the hosting order; leg 3 is a penalty
-- shootout entered in the ORIGINAL home/away order after an aggregate draw.
-- A leg may draw, whereas the finalized knockout tie cannot.
CREATE TABLE mlg_bot.tie_legs (
  match_code bigint NOT NULL REFERENCES mlg_bot.matches(code),
  leg smallint NOT NULL CHECK (leg BETWEEN 1 AND 3),
  score_home smallint NOT NULL CHECK (score_home BETWEEN 0 AND 99),
  score_away smallint NOT NULL CHECK (score_away BETWEEN 0 AND 99),
  status text NOT NULL CHECK (status IN ('pending','disputed','confirmed')),
  author text NOT NULL REFERENCES mlg_bot.users(id),
  confirmed_by text REFERENCES mlg_bot.users(id),
  disputed_by text REFERENCES mlg_bot.users(id),
  updated_at bigint NOT NULL,
  reason text,
  PRIMARY KEY(match_code,leg),
  CHECK ((status='confirmed') = (confirmed_by IS NOT NULL)),
  CHECK (status <> 'confirmed' OR confirmed_by IS DISTINCT FROM author OR coalesce(length(reason)>=8,false))
);
CREATE INDEX tie_legs_waiting ON mlg_bot.tie_legs(status,match_code) WHERE status<>'confirmed';
REVOKE ALL ON mlg_bot.tie_legs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON mlg_bot.tie_legs TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
COMMIT;
