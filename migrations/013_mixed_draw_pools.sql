BEGIN;
ALTER TABLE mlg_bot.groups DROP CONSTRAINT group_team_kind;
ALTER TABLE mlg_bot.groups ADD CONSTRAINT group_team_kind CHECK (team_kind IN ('clube','seleção','misto'));
ALTER TABLE mlg_bot.competition_templates DROP CONSTRAINT competition_templates_team_kind_check;
ALTER TABLE mlg_bot.competition_templates ADD CONSTRAINT competition_templates_team_kind_check CHECK (team_kind IN ('clube','seleção','misto'));
ALTER TABLE mlg_bot.competition_templates DROP CONSTRAINT competition_templates_teams_check;
ALTER TABLE mlg_bot.competition_templates ADD CONSTRAINT competition_templates_teams_check CHECK (cardinality(teams) BETWEEN 4 AND 200);
INSERT INTO mlg_bot.schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;
COMMIT;
