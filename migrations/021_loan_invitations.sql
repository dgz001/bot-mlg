BEGIN;
CREATE TABLE mlg_bot.loan_invitations (
 manager_id text PRIMARY KEY REFERENCES mlg_bot.users(id),
 granted_by text NOT NULL REFERENCES mlg_bot.users(id),
 active boolean NOT NULL DEFAULT true,
 granted_at timestamptz NOT NULL DEFAULT now(),
 claimed_group text REFERENCES mlg_bot.groups(id),
 revoked_at timestamptz
);
CREATE INDEX loan_invitations_claimed ON mlg_bot.loan_invitations(claimed_group) WHERE active;
REVOKE ALL ON mlg_bot.loan_invitations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON mlg_bot.loan_invitations TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
COMMIT;
