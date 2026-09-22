BEGIN;
SELECT id FROM mlg_bot.groups ORDER BY id FOR UPDATE;
DELETE FROM mlg_bot.club_pool;
INSERT INTO mlg_bot.club_pool(group_id,name) SELECT g.id,c.name FROM mlg_bot.groups g CROSS JOIN (VALUES ('Roma'),('Real Madrid'),('Barcelona'),('Atlético de Madrid'),('Flamengo'),('Corinthians'),('Palmeiras'),('Botafogo'),('Paris Saint-Germain'),('Porto'),('Benfica'),('Lyon'),('Atalanta'),('Internazionale'),('Milan'),('Sporting CP'),('Boca Juniors'),('River Plate'),('Vasco'),('Fluminense'),('Santos'),('RB Bragantino'),('Náutico'),('Cuiabá'),('Goiás'),('Vitória'),('Sport'),('Ceará')) c(name);
INSERT INTO mlg_bot.schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
COMMIT;
