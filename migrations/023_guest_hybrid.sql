BEGIN;
ALTER TABLE mlg_bot.guest_competitions ADD COLUMN qualifiers smallint;
ALTER TABLE mlg_bot.guest_competitions DROP CONSTRAINT guest_competitions_mode_check;
ALTER TABLE mlg_bot.guest_competitions ADD CONSTRAINT guest_competitions_mode_check CHECK(mode IN ('liga','copa','misto'));
ALTER TABLE mlg_bot.guest_competitions DROP CONSTRAINT guest_competitions_check;
ALTER TABLE mlg_bot.guest_competitions ADD CONSTRAINT guest_competitions_size_check CHECK(size BETWEEN 2 AND 32 AND (mode<>'copa' OR size IN (4,8,16,32)));
ALTER TABLE mlg_bot.guest_competitions ADD CONSTRAINT guest_competitions_qualifiers_check CHECK(
 (mode='misto' AND qualifiers IN (4,8,16) AND qualifiers<size)
 OR (mode<>'misto' AND qualifiers IS NULL)
);
INSERT INTO mlg_bot.schema_migrations(version) VALUES(23) ON CONFLICT DO NOTHING;
COMMIT;
