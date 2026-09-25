import type { Pool } from 'pg';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { apply, emptyState, environment, type Cup, type Event, type Match, type Participant, type Result, type Environment } from '../minicamp/engine.ts';

export interface Query {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database {
  transaction<T>(run: (q: Query) => Promise<T>): Promise<T>;
}
export function canonicalCheckpoint(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonicalCheckpoint).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>JSON.stringify(key)+':'+canonicalCheckpoint(entry)).join(',')+'}';
 return JSON.stringify(value);
}
// An independent, append-only recovery point in the same database transaction
// as the changed Cup. It records the relational state, not the WhatsApp reply.
export async function checkpointCup(q:Query,groupId:string,cupId:string,actorId:string,eventId:string):Promise<void>{
 const cup=await q.query('SELECT * FROM mlg_bot.cups WHERE id=$1 AND group_id=$2',[cupId,groupId]);
 if(cup.rows.length!==1)throw Error('Cup checkpoint unavailable');
 const participants=await q.query('SELECT * FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position',[cupId]);
 const matches=await q.query('SELECT * FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY round,position',[cupId]);
 const results=await q.query('SELECT r.* FROM mlg_bot.match_results r JOIN mlg_bot.matches m ON m.code=r.match_code WHERE m.cup_id=$1 ORDER BY r.match_code,r.revision',[cupId]);
 const state=canonicalCheckpoint({cup:cup.rows[0],participants:participants.rows,matches:matches.rows,results:results.rows});
 const sha256=createHash('sha256').update(state).digest('hex');
 await q.query('INSERT INTO mlg_bot.cup_checkpoints(group_id,cup_id,actor_id,event_id,recorded_at,state,sha256) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[groupId,cupId,actorId,eventId,Date.now(),state,sha256]);
}
type DrawMode='equipes'|'chave'|'completo';
type DrawRow={user_id:string;display_name:string;club:string;position:number};
type DrawMatch={code:number;home:string;away:string;round:number;position:number;status:string};
function shuffleDifferent<T>(values:T[]):T[]{
 const drawn=[...values];for(let i=drawn.length-1;i>0;i--){const j=randomInt(i+1);[drawn[i],drawn[j]]=[drawn[j]!,drawn[i]!];}
 if(drawn.length>1&&drawn.every((v,i)=>v===values[i]))drawn.push(drawn.shift()!);
 return drawn;
}
export async function cupDraw(database:Database,request:{group:string;controlGroup:string;actorAliases:string[];mode?:DrawMode;expected?:string;reason?:string}):Promise<{error?:string;cupId?:string;name?:string;fingerprint?:string;participants?:DrawRow[];matches?:DrawMatch[];changed?:boolean;mode?:DrawMode}>{
 return database.transaction(async q=>{
  const authorized=await q.query<{id:string}>('SELECT DISTINCT a.user_id AS id FROM mlg_bot.admins a JOIN mlg_bot.wa_identities w ON w.user_id=a.user_id JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.group_id=$1 AND w.jid=ANY($2::text[]) AND g.authorized AND g.admins_configured',[request.controlGroup,request.actorAliases]);
  if(!authorized.rows.length)return {error:'Sua conta não está entre os ADMs da central.'};
  const actor=authorized.rows[0]!.id;
  const group=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[request.group]);
  if(!group.rows.length)return {error:'Grupo da Copa não autorizado.'};
  const cups=await q.query<{id:string;competition_name:string;size:number;status:string}>("SELECT id,competition_name,size,status FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[request.group]);
  const cup=cups.rows[0];if(!cup||cup.status!=='playing')return {error:'O sorteio só pode ser revisto depois que as vagas fecharem.'};
  const participants=await q.query<DrawRow>('SELECT user_id,display_name,club,position FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position FOR UPDATE',[cup.id]);
  const matches=await q.query<DrawMatch>('SELECT code::float8 AS code,home,away,round,position,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY round,position FOR UPDATE',[cup.id]);
  const started=await q.query('SELECT 1 FROM mlg_bot.match_results r JOIN mlg_bot.matches m ON m.code=r.match_code WHERE m.cup_id=$1 LIMIT 1',[cup.id]);
  if(started.rows.length||matches.rows.some(m=>m.status!=='scheduled'||m.round!==0)||matches.rows.length!==cup.size/2||participants.rows.length!==cup.size||participants.rows.some(p=>!p.club))return {error:'Sorteio bloqueado: já há resultado, alteração de jogo ou chave incompleta. Corrija a partida pelo fluxo de revisão.'};
  const fingerprint=createHash('sha256').update(JSON.stringify([cup.id,participants.rows,matches.rows])).digest('hex');
  if(!request.mode)return {cupId:cup.id,name:cup.competition_name,fingerprint,participants:participants.rows,matches:matches.rows};
  if(request.expected!==fingerprint)return {error:'O sorteio mudou depois da revisão. Envie !sorteio e prepare a correção novamente.'};
  const before=structuredClone({participants:participants.rows,matches:matches.rows});
  await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',['mlg-control-panel','Painel MLG']);
  const eventId='redraw-'+randomUUID();
  await checkpointCup(q,request.group,cup.id,actor,eventId+'-before');
  if(request.mode!=='chave'){
   const clubs=shuffleDifferent(participants.rows.map(p=>p.club));
   // UNIQUE(cup_id,club) is immediate: release old assignments inside this
   // transaction before reassigning the same pool to different players.
   await q.query('UPDATE mlg_bot.cup_participants SET club=NULL WHERE cup_id=$1',[cup.id]);
   for(const [i,p] of participants.rows.entries()){p.club=clubs[i]!;await q.query('UPDATE mlg_bot.cup_participants SET club=$3 WHERE cup_id=$1 AND user_id=$2',[cup.id,p.user_id,p.club]);}
  }
  if(request.mode!=='equipes'){
   const ids=shuffleDifferent(matches.rows.flatMap(m=>[m.home,m.away]));
   for(const [i,m] of matches.rows.entries()){m.home=ids[i*2]!;m.away=ids[i*2+1]!;await q.query('UPDATE mlg_bot.matches SET home=$2,away=$3 WHERE code=$1 AND cup_id=$4',[m.code,m.home,m.away,cup.id]);}
  }
  await q.query('INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,occurred_at,action,before_state,after_state,outcome) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',[actor,request.group,cup.id,Date.now(),'redraw-'+request.mode,JSON.stringify({...before,reason:request.reason}),JSON.stringify({participants:participants.rows,matches:matches.rows}),'accepted']);
  await checkpointCup(q,request.group,cup.id,actor,eventId+'-after');
  const users=new Map(participants.rows.map(p=>[p.user_id,p]));
  const kind=request.mode==='equipes'?'as equipes':request.mode==='chave'?'os confrontos':'as equipes e os confrontos';
  const notice='🎲 SORTEIO ATUALIZADO · '+cup.competition_name+'\nA central refez '+kind+'. Motivo: '+request.reason+'\n\n⚔️ CONFRONTOS E EQUIPES\n\n'+matches.rows.map(m=>`🎮 JOGO ${m.code}\n${users.get(m.home)?.display_name} · ${users.get(m.home)?.club}\n       ×\n${users.get(m.away)?.display_name} · ${users.get(m.away)?.club}`).join('\n\n')+'\n\n📸 Os confrontos anteriores foram substituídos. Enviem o print antes de registrar o placar.';
  const messageId='panel-'+randomUUID();await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4)',[request.group,'mlg-control-panel',messageId,Date.now()]);
  await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[request.group,'mlg-control-panel',messageId,notice]);
  return {changed:true,cupId:cup.id,name:cup.competition_name,mode:request.mode,participants:participants.rows,matches:matches.rows};
 });
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
    const groups = await q.query<{ id: string; authorized: boolean; competitionName:string; teamKind:"clube"|"seleção"|"misto"; formatSize:number|null }>('SELECT id,authorized,competition_name AS "competitionName",team_kind AS "teamKind",format_size AS "formatSize" FROM mlg_bot.groups WHERE id=$1 FOR UPDATE', [event.groupId]);
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
    state.groups[event.groupId] = { authorized: true, admins: admins.rows.map(r => r.id), clubs: clubs.rows.map(r => r.name), competitionName:groups.rows[0]!.competitionName,teamKind:groups.rows[0]!.teamKind,formatSize:groups.rows[0]!.formatSize };
    const drafts = await q.query<{ ownerId: string; expiresAt: number }>('SELECT owner_id AS "ownerId",expires_at::float8 AS "expiresAt" FROM mlg_bot.command_drafts WHERE group_id=$1', [event.groupId]);
    if (drafts.rows[0]) state.drafts[event.groupId] = drafts.rows[0];
    const cups = await q.query<Omit<Cup,'participants'|'matches'>>(`SELECT id,group_id AS "groupId",created_by AS "createdBy",created_at::float8 AS "createdAt",
      size,competition_name AS "competitionName",team_kind AS "teamKind",status,champion,completed_at::float8 AS "completedAt",cancellation_reason AS "cancellationReason" FROM mlg_bot.cups WHERE group_id=$1 ORDER BY created_at,id`, [event.groupId]);
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
      await q.query(`INSERT INTO mlg_bot.cups(id,group_id,created_by,created_at,size,competition_name,team_kind,status,champion,completed_at,cancellation_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET status=excluded.status,champion=excluded.champion,completed_at=excluded.completed_at,cancellation_reason=excluded.cancellation_reason`,
      [cup.id,cup.groupId,cup.createdBy,cup.createdAt,cup.size,cup.competitionName??"Minicamp MLG",cup.teamKind??"clube",cup.status,cup.champion ?? null,cup.completedAt ?? null,cup.cancellationReason ?? null]);
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
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(match_code,revision) DO UPDATE SET status=excluded.status,confirmed_by=excluded.confirmed_by,disputed_by=excluded.disputed_by,reason=excluded.reason`,
          [m.code,index+1,r.home,r.away,r.author,r.at,r.status,r.confirmedBy ?? null,r.disputedBy ?? null,r.reason ?? null]);
        }
      }
      await checkpointCup(q,event.groupId,cup.id,event.userId,event.id);
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
