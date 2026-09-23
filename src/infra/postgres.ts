import type { Pool } from 'pg';
import { apply, emptyState, environment, type Cup, type Event, type Match, type Participant, type Result, type Environment } from '../minicamp/engine.ts';

export interface Query {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database {
  transaction<T>(run: (q: Query) => Promise<T>): Promise<T>;
}
export function pgDatabase(pool: Pool): Database {
  return {
    async transaction<T>(run: (q: Query) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '10s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        const q: Query = { async query<T>(sql: string, values?: unknown[]) {
          const result = await client.query(sql, values);
          return { rows: result.rows as T[] };
        } };
        const result = await run(q);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    },
  };
}

// All identifiers here are canonical IDs resolved by a trusted WhatsApp adapter.
// The authenticated DB role is private backend-only, never available to members.
export async function processEvent(database: Database, event: Event, env: Environment = environment): Promise<{ duplicate: boolean; notices: string[] }> {
  const startedAt=Date.now();
  return database.transaction(async q => {
    const groups = await q.query<{ id: string; authorized: boolean }>('SELECT id,authorized FROM mlg_bot.groups WHERE id=$1 FOR UPDATE', [event.groupId]);
    if (!groups.rows[0]?.authorized) throw new Error('Grupo não autorizado.');
    await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name', [event.userId,event.name.slice(0,60)]);
    const claimed = await q.query<{ message_id: string }>(`INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id`, [event.groupId,event.userId,event.id,event.at]);
    if (!claimed.rows.length) return { duplicate: true, notices: [] };
    // Global counter lock ensures that independent groups never allocate the same code.
    // Small community scale: intentionally serialized. Replace with reserved sequence
    // ranges if volume warrants it, preserving the domain's allocation contract.
    const counter = await q.query<{ next: string }>("SELECT next_code::text AS next FROM mlg_bot.counters WHERE id='match' FOR UPDATE");
    if (!counter.rows[0]) throw new Error('Migration required: missing match counter');
    const state = emptyState(); state.nextCode = Number(counter.rows[0].next);
    const admins = await q.query<{ id: string }>('SELECT user_id AS id FROM mlg_bot.admins WHERE group_id=$1 AND EXISTS(SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND admins_configured)', [event.groupId]);
    const clubs = await q.query<{ name: string }>('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1 ORDER BY name', [event.groupId]);
    state.groups[event.groupId] = { authorized: true, admins: admins.rows.map(r => r.id), clubs: clubs.rows.map(r => r.name) };
    const drafts = await q.query<{ ownerId: string; expiresAt: number }>('SELECT owner_id AS "ownerId",expires_at::float8 AS "expiresAt" FROM mlg_bot.command_drafts WHERE group_id=$1', [event.groupId]);
    if (drafts.rows[0]) state.drafts[event.groupId] = drafts.rows[0];
    const cups = await q.query<Omit<Cup,'participants'|'matches'>>(`SELECT id,group_id AS "groupId",created_by AS "createdBy",created_at::float8 AS "createdAt",
      size,status,champion,completed_at::float8 AS "completedAt",cancellation_reason AS "cancellationReason" FROM mlg_bot.cups WHERE group_id=$1 ORDER BY created_at,id`, [event.groupId]);
    for (const row of cups.rows) {
      const cup: Cup = { ...row, champion: row.champion ?? undefined, completedAt: row.completedAt ?? undefined, cancellationReason: row.cancellationReason ?? undefined, participants: [], matches: [] };
      const participants = await q.query<Participant>('SELECT user_id AS "userId",display_name AS name,club FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position', [cup.id]);
      cup.participants = participants.rows.map(p => ({ ...p, club: p.club ?? undefined }));
      const matches = await q.query<Omit<Match,'results'>>('SELECT code::float8 AS code,round,position,home,away,winner,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY round,position', [cup.id]);
      for (const m of matches.rows) {
        const results = await q.query<Result>('SELECT home,away,author,created_at::float8 AS at,status,confirmed_by AS "confirmedBy",disputed_by AS "disputedBy",reason FROM mlg_bot.match_results WHERE match_code=$1 ORDER BY revision', [m.code]);
        cup.matches.push({ ...m, winner: m.winner ?? undefined, results: results.rows.map(r => ({ ...r, confirmedBy: r.confirmedBy ?? undefined, disputedBy: r.disputedBy ?? undefined, reason: r.reason ?? undefined })) });
      }
      state.cups[cup.id] = cup;
    }
    const profiles=await q.query<{userId:string;name:string}>('SELECT user_id AS "userId",display_name AS name FROM mlg_bot.coach_profiles WHERE group_id=$1',[event.groupId]);
    state.profiles={[event.groupId]:Object.fromEntries(profiles.rows.map(p=>[p.userId,p.name]))};
    const output = apply(state,event,env);
    for(const [id,name] of Object.entries(output.state.profiles?.[event.groupId]??{})){
      if(state.profiles[event.groupId]?.[id]===name)continue;
      await q.query('INSERT INTO mlg_bot.coach_profiles(group_id,user_id,display_name) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id) DO UPDATE SET display_name=excluded.display_name',[event.groupId,id,name]);
    }
    for (const cup of Object.values(output.state.cups)) {
      if (JSON.stringify(state.cups[cup.id]) === JSON.stringify(cup)) continue;
      await q.query(`INSERT INTO mlg_bot.cups(id,group_id,created_by,created_at,size,status,champion,completed_at,cancellation_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET status=excluded.status,champion=excluded.champion,completed_at=excluded.completed_at,cancellation_reason=excluded.cancellation_reason`,
      [cup.id,cup.groupId,cup.createdBy,cup.createdAt,cup.size,cup.status,cup.champion ?? null,cup.completedAt ?? null,cup.cancellationReason ?? null]);
      // Withdrawal is allowed only before the draw, so no match references exist.
      if(cup.status==='open'){
        await q.query('DELETE FROM mlg_bot.cup_participants WHERE cup_id=$1',[cup.id]);
        // Reinsert in current order; there are no matches or champion references yet.
      }
      for (const [position,p] of cup.participants.entries()) {
        await q.query(`INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position,club) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT(cup_id,user_id) DO UPDATE SET club=excluded.club`, [cup.id,p.userId,p.name,position,p.club ?? null]);
      }
      for (const m of cup.matches) {
        await q.query(`INSERT INTO mlg_bot.matches(code,cup_id,round,position,home,away,winner,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(code) DO UPDATE SET winner=excluded.winner,status=excluded.status,home=excluded.home,away=excluded.away`, [m.code,cup.id,m.round,m.position,m.home,m.away,m.winner ?? null,m.status]);
        for (const [index,r] of m.results.entries()) {
          await q.query(`INSERT INTO mlg_bot.match_results(match_code,revision,home,away,author,created_at,status,confirmed_by,disputed_by,reason)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(match_code,revision) DO UPDATE SET status=excluded.status,confirmed_by=excluded.confirmed_by,disputed_by=excluded.disputed_by`,
          [m.code,index+1,r.home,r.away,r.author,r.at,r.status,r.confirmedBy ?? null,r.disputedBy ?? null,r.reason ?? null]);
        }
      }
    }
    const draft = output.state.drafts[event.groupId];
    if (draft) await q.query(`INSERT INTO mlg_bot.command_drafts(group_id,owner_id,expires_at) VALUES ($1,$2,$3)
      ON CONFLICT(group_id) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at`, [event.groupId,draft.ownerId,draft.expiresAt]);
    else await q.query('DELETE FROM mlg_bot.command_drafts WHERE group_id=$1',[event.groupId]);
    await q.query("UPDATE mlg_bot.counters SET next_code=$1 WHERE id='match'", [output.state.nextCode]);
    for (const a of output.state.audit) {
      await q.query(`INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,match_code,occurred_at,action,before_state,after_state,outcome)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,[a.actor,a.groupId,a.cupId,a.matchCode ?? null,a.at,a.action,a.before,a.after,a.outcome]);
    }
    if(event.text.trim().toLowerCase()==='!supabase'){
      const check=await q.query<{message_id:string}>('SELECT message_id FROM mlg_bot.processed_messages WHERE group_id=$1 AND user_id=$2 AND message_id=$3',[event.groupId,event.userId,event.id]);
      if(check.rows.length!==1)throw new Error('Database diagnostic failed');
      output.notices[0]+=`\n✅ PostgreSQL: leitura e gravação do diagnóstico verificadas.\n⏱️ Processamento no banco: ${Math.max(0,Date.now()-startedAt)} ms (não é o tempo total do WhatsApp).\n📨 Se você está lendo esta resposta, o caminho de ida e volta funcionou neste momento. Isso não garante disponibilidade futura.\nSe o bot parar de responder, consulte o painel; ausência de resposta não significa teste aprovado.`;
    }
    for (const [ordinal,body] of output.notices.entries()) {
      await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,$4,$5)',[event.groupId,event.userId,event.id,ordinal,body]);
    }
    return { duplicate: false, notices: output.notices };
  });
}
