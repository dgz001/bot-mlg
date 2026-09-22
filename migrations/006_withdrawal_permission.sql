BEGIN;
GRANT DELETE ON mlg_bot.cup_participants TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
COMMIT;
