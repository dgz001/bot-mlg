BEGIN;
-- Pair winners as soon as both feeder games are confirmed. This also repairs
-- active brackets created before progressive advancement was available.
DO $repair$
DECLARE
  cup_row record;
  pair_row record;
  next_match_code bigint;
BEGIN
  FOR cup_row IN
    SELECT c.id,c.group_id,c.created_by,c.size FROM mlg_bot.cups c
    JOIN mlg_bot.groups g ON g.id=c.group_id
    WHERE c.status='playing' ORDER BY g.id,c.id
  LOOP
    PERFORM 1 FROM mlg_bot.groups WHERE id=cup_row.group_id FOR UPDATE;
    FOR pair_row IN
      SELECT left_game.round+1 AS next_round,left_game.position/2 AS next_position,
             left_game.winner AS home,right_game.winner AS away
      FROM mlg_bot.matches left_game
      JOIN mlg_bot.matches right_game ON right_game.cup_id=left_game.cup_id
        AND right_game.round=left_game.round AND right_game.position=left_game.position+1
      WHERE left_game.cup_id=cup_row.id AND left_game.position%2=0
        AND left_game.round < (SELECT floor(log(2,cup_row.size::numeric))::integer)-1
        AND left_game.status='confirmed' AND right_game.status='confirmed'
        AND NOT EXISTS (SELECT 1 FROM mlg_bot.matches target WHERE target.cup_id=cup_row.id
          AND target.round=left_game.round+1 AND target.position=left_game.position/2)
      ORDER BY left_game.round,left_game.position
    LOOP
      SELECT next_code INTO next_match_code FROM mlg_bot.counters WHERE id='match' FOR UPDATE;
      INSERT INTO mlg_bot.matches(code,cup_id,round,position,home,away,status)
      VALUES(next_match_code,cup_row.id,pair_row.next_round,pair_row.next_position,pair_row.home,pair_row.away,'scheduled');
      UPDATE mlg_bot.counters SET next_code=next_code+1 WHERE id='match';
      INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,match_code,occurred_at,action,after_state,outcome)
      VALUES(cup_row.created_by,cup_row.group_id,cup_row.id,next_match_code,
        (extract(epoch from clock_timestamp())*1000)::bigint,'progressive-round-backfill',
        jsonb_build_object('round',pair_row.next_round,'position',pair_row.next_position,
          'home',pair_row.home,'away',pair_row.away),'accepted');
    END LOOP;
  END LOOP;
END $repair$;
INSERT INTO mlg_bot.schema_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;
COMMIT;
