BEGIN;
-- The private gateway alone may clear season records after a verified
-- WhatsApp administrator completes the two-step confirmation.
GRANT DELETE ON mlg_bot.outbox,mlg_bot.inbox,mlg_bot.processed_messages,
  mlg_bot.command_rate,mlg_bot.cup_checkpoints,mlg_bot.audit_logs,
  mlg_bot.match_results,mlg_bot.matches,mlg_bot.cups TO mlg_bot_gateway;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;
COMMIT;
