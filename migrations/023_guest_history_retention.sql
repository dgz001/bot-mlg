BEGIN;

-- Completed guest competitions remain queryable with their original players,
-- fixtures, scores and result audit. The archive marker makes this operation
-- idempotent without deleting the sporting record.
ALTER TABLE mlg_bot.guest_competitions
  ADD COLUMN archived_at bigint;

CREATE INDEX guest_competitions_pending_archive
  ON mlg_bot.guest_competitions(status, completed_at, created_at)
  WHERE archived_at IS NULL;

INSERT INTO mlg_bot.schema_migrations(version)
VALUES (23)
ON CONFLICT DO NOTHING;

COMMIT;
