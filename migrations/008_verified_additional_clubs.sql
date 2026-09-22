BEGIN;
SELECT id FROM mlg_bot.groups ORDER BY id FOR UPDATE;
INSERT INTO mlg_bot.club_pool(group_id,name) SELECT g.id,c.name FROM mlg_bot.groups g CROSS JOIN (VALUES ('São Paulo'),('Club América'),('CD Guadalajara')) c(name) ON CONFLICT DO NOTHING;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
COMMIT;
