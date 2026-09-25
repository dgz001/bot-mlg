BEGIN;
CREATE TABLE mlg_bot.competition_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id text NOT NULL REFERENCES mlg_bot.groups(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 3 AND 60),
  team_kind text NOT NULL CHECK (team_kind IN ('clube','seleção')),
  teams text[] NOT NULL CHECK (cardinality(teams) BETWEEN 4 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id,id)
);
CREATE UNIQUE INDEX competition_template_name ON mlg_bot.competition_templates(group_id,lower(name));
ALTER TABLE mlg_bot.groups ADD COLUMN active_template_id uuid;
ALTER TABLE mlg_bot.groups ADD CONSTRAINT active_template_in_group
  FOREIGN KEY (id,active_template_id) REFERENCES mlg_bot.competition_templates(group_id,id);
INSERT INTO mlg_bot.competition_templates(group_id,name,team_kind,teams)
SELECT g.id,g.competition_name,g.team_kind,array_agg(t.name ORDER BY t.name)
FROM mlg_bot.groups g JOIN mlg_bot.club_pool t ON t.group_id=g.id
GROUP BY g.id HAVING count(*) BETWEEN 4 AND 100;
UPDATE mlg_bot.groups g SET active_template_id=t.id
FROM mlg_bot.competition_templates t WHERE t.group_id=g.id AND t.name=g.competition_name;
REVOKE ALL ON mlg_bot.competition_templates FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON mlg_bot.competition_templates TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
COMMIT;
