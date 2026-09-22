BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE TABLE mlg_bot.availability_checks (
 request_id bigint PRIMARY KEY, requested_at timestamptz NOT NULL DEFAULT now(),
 status_code integer, timed_out boolean, error_message text, checked_at timestamptz
);
REVOKE ALL ON mlg_bot.availability_checks FROM PUBLIC,anon,authenticated;
CREATE FUNCTION mlg_bot.check_tournament_availability() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
BEGIN
 UPDATE mlg_bot.availability_checks c SET status_code=r.status_code,timed_out=r.timed_out,
 error_message=left(r.error_msg,240),checked_at=now()
 FROM net._http_response r WHERE c.request_id=r.id AND c.checked_at IS NULL;
 UPDATE mlg_bot.availability_checks SET checked_at=now(),timed_out=true,error_message='No response within monitoring window'
 WHERE checked_at IS NULL AND requested_at<now()-interval '10 minutes';
 DELETE FROM mlg_bot.availability_checks WHERE requested_at<now()-interval '7 days';
 IF EXISTS(SELECT 1 FROM mlg_bot.cups c JOIN mlg_bot.groups g ON g.id=c.group_id WHERE g.authorized AND c.status IN ('open','playing')) THEN
  INSERT INTO mlg_bot.availability_checks(request_id)
  SELECT net.http_get(url:='https://mlg-bot-runtime.onrender.com/readyz',timeout_milliseconds:=10000);
 END IF;
END;$body$;
REVOKE ALL ON FUNCTION mlg_bot.check_tournament_availability() FROM PUBLIC,anon,authenticated;
SELECT cron.schedule('mlg-bot-tournament-health','*/5 * * * *','SELECT mlg_bot.check_tournament_availability()');
INSERT INTO mlg_bot.schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
COMMIT;