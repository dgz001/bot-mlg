BEGIN;
ALTER TABLE mlg_bot.admins DROP CONSTRAINT admins_role_check;
ALTER TABLE mlg_bot.admins ADD CONSTRAINT admins_role_check CHECK(role IN ('owner','admin','channel'));
INSERT INTO mlg_bot.schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
COMMIT;
