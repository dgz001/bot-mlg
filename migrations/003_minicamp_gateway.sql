BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mlg_bot_gateway') THEN
  CREATE ROLE mlg_bot_gateway NOLOGIN;
 END IF;
END $$;
GRANT mlg_bot_gateway TO postgres;
GRANT USAGE ON SCHEMA mlg_bot TO mlg_bot_gateway;
GRANT SELECT,INSERT,UPDATE ON mlg_bot.users,mlg_bot.wa_identities,mlg_bot.groups,mlg_bot.admins,mlg_bot.club_pool,mlg_bot.command_drafts,mlg_bot.counters,mlg_bot.cups,mlg_bot.cup_participants,mlg_bot.matches,mlg_bot.match_results,mlg_bot.processed_messages,mlg_bot.audit_logs,mlg_bot.outbox,mlg_bot.inbox,mlg_bot.command_rate,mlg_bot.control_audit TO mlg_bot_gateway;
GRANT DELETE ON mlg_bot.command_drafts TO mlg_bot_gateway;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA mlg_bot TO mlg_bot_gateway;
ALTER TABLE mlg_bot.outbox ADD COLUMN IF NOT EXISTS delivery_token text;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
