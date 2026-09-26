import type { Pool } from 'pg';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { apply, emptyState, environment, type Cup, type Event, type Match, type Participant, type Result, type Environment } from '../minicamp/engine.ts';
import {teamLabel} from '../minicamp/team-badges.ts';
import {allowedDrawTeam} from '../minicamp/nations.ts';

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
  const authorized=await q.query<{id:string}>('SELECT DISTINCT a.user_id AS id FROM mlg_bot.admins a JOIN mlg_bot.wa_identities w ON w.user_id=a.user_id JOIN mlg_bot.groups g ON g.id=a.group_id WHERE w.jid=ANY($1::text[]) AND g.authorized AND g.admins_configured',[request.actorAliases]);
  if(!authorized.rows.length)return {error:'Sua conta não está entre os ADMs da central.'};
  const actor=authorized.rows[0]!.id;
  const group=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[request.group]);
  if(!group.rows.length)return {error:'Grupo da Copa não autorizado.'};
  const cups=await q.query<{id:string;competition_name:string;team_kind:'clube'|'seleção'|'misto';size:number;status:string}>("SELECT id,competition_name,team_kind,size,status FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[request.group]);
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
  const notice='🎲 SORTEIO ATUALIZADO · '+cup.competition_name+'\nA central refez '+kind+'. Motivo: '+request.reason+'\n\n⚔️ CONFRONTOS E EQUIPES\n\n'+matches.rows.map(m=>`🔹 LADO ${m.position<cup.size/4?'A':'B'} · JOGO ${m.code}\n${users.get(m.home)?.display_name} · ${teamLabel(users.get(m.home)?.club,cup.team_kind)}\n       ×\n${users.get(m.away)?.display_name} · ${teamLabel(users.get(m.away)?.club,cup.team_kind)}`).join('\n\n')+'\n\n📸 Os confrontos anteriores foram substituídos. Enviem o print antes de registrar o placar.';
  const messageId='panel-'+randomUUID();await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4)',[request.group,'mlg-control-panel',messageId,Date.now()]);
  await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[request.group,'mlg-control-panel',messageId,notice]);
  return {changed:true,cupId:cup.id,name:cup.competition_name,mode:request.mode,participants:participants.rows,matches:matches.rows};
 });
}
// Replace only a participant's team. The group lock serializes this with match
// results, draw changes and other replacements; the message ID makes retries safe.
export async function cupRerollTeam(database:Database,request:{group:string;actorAliases:string[];targetAliases?:string[];targetName?:string;messageId:string;reason:string}):Promise<{error?:string;changed?:boolean;duplicate?:boolean;name?:string;oldTeam?:string;newTeam?:string}>{
 return database.transaction(async q=>{
  const actor=await q.query<{user_id:string}>(`SELECT DISTINCT a.user_id FROM mlg_bot.admins a
    JOIN mlg_bot.wa_identities w ON w.user_id=a.user_id JOIN mlg_bot.groups g ON g.id=a.group_id
    WHERE w.jid=ANY($1::text[]) AND g.authorized AND g.admins_configured`,[request.actorAliases]);
  if(actor.rows.length!==1)return {error:'Somente ADMs selecionados podem trocar uma equipe.'};
  const admin=actor.rows[0]!.user_id;
  const group=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[request.group]);
  if(!group.rows.length)return {error:'Grupo da Copa não autorizado.'};
  const previous=await q.query('SELECT 1 FROM mlg_bot.processed_messages WHERE group_id=$1 AND user_id=$2 AND message_id=$3',[request.group,admin,request.messageId]);
  if(previous.rows.length)return {duplicate:true};
  const cups=await q.query<{id:string;competition_name:string;team_kind:'clube'|'seleção'|'misto'}>("SELECT id,competition_name,team_kind FROM mlg_bot.cups WHERE group_id=$1 AND status='playing' FOR UPDATE",[request.group]);
  const cup=cups.rows[0];if(!cup)return {error:'Não há Copa sorteada em andamento. A troca de time só vale durante a disputa.'};
  const participants=await q.query<DrawRow>('SELECT user_id,display_name,club,position FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position FOR UPDATE',[cup.id]);
  let player:DrawRow|undefined;
  if(request.targetAliases){
   const targets=await q.query<{user_id:string}>('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[request.targetAliases]);
   if(targets.rows.length!==1)return {error:'Menção não reconhecida. Marque a conta do participante que recebeu a seleção.'};
   player=participants.rows.find(p=>p.user_id===targets.rows[0]!.user_id);
  }else{
   const normalized=(name:string)=>name.trim().replace(/^@+/,'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR').replace(/\s+/g,' ');
   const wanted=normalized(request.targetName??'');
   const exact=participants.rows.filter(p=>normalized(p.display_name)===wanted);
   const choices=exact.length?exact:participants.rows.filter(p=>normalized(p.display_name).startsWith(wanted+' '));
   if(choices.length>1)return {error:'Há mais de um participante com esse nome. Marque a conta no comando: !sorteio @pessoa.'};
   player=choices[0];
  }
  if(!player?.club)return {error:'Participante sem time sorteado nesta Copa. Confira o nome com !participantes ou marque a conta.'};
  const used=await q.query<{club:string}>('SELECT club FROM mlg_bot.cup_participants WHERE cup_id=$1 AND club IS NOT NULL',[cup.id]);
  const retired=await q.query<{club:string}>("SELECT before_state->>'oldTeam' AS club FROM mlg_bot.audit_logs WHERE cup_id=$1 AND action='team-reroll'",[cup.id]);
  const unavailable=new Set([...used.rows,...retired.rows].map(p=>p.club?.toLocaleLowerCase('pt-BR')));
  const pool=await q.query<{name:string}>('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1',[request.group]);
  const available=pool.rows.filter(p=>allowedDrawTeam(p.name,cup.team_kind)&&!unavailable.has(p.name.toLocaleLowerCase('pt-BR')));
  if(!available.length)return {error:'Nenhum time livre nesta Copa. Acrescente uma opção válida à lista pelo painel antes de repetir o comando.'};
  const chosen=available[randomInt(available.length)]!.name;
  const eventId='team-reroll-'+randomUUID();
  await checkpointCup(q,request.group,cup.id,admin,eventId+'-before');
  await q.query('UPDATE mlg_bot.cup_participants SET club=$3 WHERE cup_id=$1 AND user_id=$2',[cup.id,player.user_id,chosen]);
  const at=Date.now();
  await q.query(`INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,occurred_at,action,before_state,after_state,outcome)
    VALUES($1,$2,$3,$4,'team-reroll',$5::jsonb,$6::jsonb,'accepted')`,[admin,request.group,cup.id,at,JSON.stringify({userId:player.user_id,oldTeam:player.club,reason:request.reason}),JSON.stringify({userId:player.user_id,newTeam:chosen})]);
  await checkpointCup(q,request.group,cup.id,admin,eventId+'-after');
  const fixture=await q.query<{code:number;round:number;status:string}>(`SELECT code::float8 AS code,round,status FROM mlg_bot.matches
    WHERE cup_id=$1 AND (home=$2 OR away=$2) ORDER BY round DESC,code DESC LIMIT 1`,[cup.id,player.user_id]);
  const match=fixture.rows[0];
  const stage=match?match.status==='confirmed'?'Os resultados anteriores continuam válidos; a situação do jogador não mudou.':`Jogo ${match.code} mantido; placar e chave preservados.`:'Chave e classificação preservadas.';
  const message=`🎲 NOVO TIME · ${cup.competition_name.toUpperCase()}\n👤 ${player.display_name}\n${teamLabel(player.club,cup.team_kind)} → ${teamLabel(chosen,cup.team_kind)}\n\n📝 Motivo: ${request.reason}\n🔒 ${stage}\nA equipe anterior não voltará ao sorteio desta edição. Confira os confrontos com !copa.`;
  await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4)',[request.group,admin,request.messageId,at]);
  await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[request.group,admin,request.messageId,message]);
  return {changed:true,name:player.display_name,oldTeam:player.club,newTeam:chosen};
 });
}
export type RosterRequest={group:string;controlGroup:string;actorAliases:string[];change?:'incluir'|'retirar'|'trocar';position?:number;targetAliases?:string[];targetName?:string;expected?:string;reason?:string};
export async function cupRoster(database:Database,request:RosterRequest):Promise<{error?:string;cupId?:string;name?:string;size?:number;status?:string;fingerprint?:string;participants?:DrawRow[];changed?:boolean}>{
 return database.transaction(async q=>{
  const admins=await q.query<{id:string}>('SELECT DISTINCT a.user_id AS id FROM mlg_bot.admins a JOIN mlg_bot.wa_identities w ON w.user_id=a.user_id JOIN mlg_bot.groups g ON g.id=a.group_id WHERE w.jid=ANY($1::text[]) AND g.authorized AND g.admins_configured',[request.actorAliases]);
  if(!admins.rows.length)return {error:'Sua conta não está entre os ADMs da central.'};
  const actor=admins.rows[0]!.id;
  const group=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[request.group]);if(!group.rows.length)return {error:'Grupo da Copa não autorizado.'};
  const cups=await q.query<{id:string;competition_name:string;team_kind:'clube'|'seleção'|'misto';size:number;status:string}>("SELECT id,competition_name,team_kind,size,status FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[request.group]);
  const cup=cups.rows[0];if(!cup)return {error:'Não há Copa aberta neste grupo.'};
  const people=await q.query<DrawRow>('SELECT user_id,display_name,club,position FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position FOR UPDATE',[cup.id]);
  const matches=await q.query<DrawMatch>('SELECT code::float8 AS code,home,away,round,position,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY round,position FOR UPDATE',[cup.id]);
  const results=await q.query('SELECT 1 FROM mlg_bot.match_results r JOIN mlg_bot.matches m ON m.code=r.match_code WHERE m.cup_id=$1 LIMIT 1',[cup.id]);
  const fingerprint=createHash('sha256').update(JSON.stringify([cup.id,cup.status,people.rows,matches.rows,Boolean(results.rows.length)])).digest('hex');
  if(!request.change)return {cupId:cup.id,name:cup.competition_name,size:cup.size,status:cup.status,fingerprint,participants:people.rows};
  if(request.expected!==fingerprint)return {error:'A lista da Copa mudou depois da revisão. Use !inscritosadm e prepare a mudança novamente.'};
  const current=request.position?people.rows[request.position-1]:undefined;
  if(request.change!=='incluir'&&!current)return {error:'Jogador não encontrado nessa posição. Consulte !inscritosadm.'};
  if(cup.status==='playing'&&(request.change!=='trocar'||results.rows.length||matches.rows.some(m=>m.round!==0||m.status!=='scheduled')||matches.rows.length!==cup.size/2))return {error:'Com partidas sorteadas, só é possível substituir antes do primeiro placar. Use !resolver para corrigir jogos já disputados.'};
  if(cup.status==='playing'&&current&&matches.rows.flatMap(m=>[m.home,m.away]).filter(id=>id===current.user_id).length!==1)return {error:'Confronto incompleto: revise a chave antes de trocar este jogador.'};
  if(request.change==='incluir'&&(cup.status!=='open'||people.rows.length>=cup.size))return {error:'Só há inclusão com inscrições abertas e vaga disponível.'};
  if(request.change==='incluir'&&people.rows.length+1===cup.size){
   const pool=await q.query<{name:string}>('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1',[request.group]);
   if(pool.rows.filter(p=>allowedDrawTeam(p.name,cup.team_kind)).length<cup.size)return {error:'Não há equipes válidas suficientes para completar o sorteio. Corrija o modelo antes da última inscrição.'};
  }
  let targetId:string|undefined;
  if(request.change!=='retirar'){
   const aliases=request.targetAliases??[];
   await q.query('SELECT pg_advisory_xact_lock(71012027)');
   const known=await q.query<{user_id:string}>('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[aliases]);
   if(known.rows.length>1)return {error:'As identidades do WhatsApp estão em conflito. Corrija o vínculo no painel.'};
   targetId=known.rows[0]?.user_id??randomUUID();
   if(people.rows.some(p=>p.user_id===targetId))return {error:'Esta conta já está inscrita na Copa.'};
   await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[targetId,request.targetName]);
   for(const jid of aliases)await q.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[jid,targetId]);
  }
  const before={participants:structuredClone(people.rows),matches:structuredClone(matches.rows)};
  const eventId='roster-'+randomUUID();await checkpointCup(q,request.group,cup.id,actor,eventId+'-before');
  if(request.change==='incluir'){
   const position=people.rows.length?Math.max(...people.rows.map(p=>p.position))+1:0;
   await q.query('INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position,club) VALUES($1,$2,$3,$4,NULL)',[cup.id,targetId,request.targetName,position]);
  }else if(request.change==='retirar'){
   await q.query('DELETE FROM mlg_bot.cup_participants WHERE cup_id=$1 AND user_id=$2',[cup.id,current!.user_id]);
  }else if(cup.status==='open'){
   await q.query('DELETE FROM mlg_bot.cup_participants WHERE cup_id=$1 AND user_id=$2',[cup.id,current!.user_id]);
   await q.query('INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position,club) VALUES($1,$2,$3,$4,NULL)',[cup.id,targetId,request.targetName,current!.position]);
  }else{
   const temporary=Math.max(...people.rows.map(p=>p.position))+1;
   await q.query('INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position,club) VALUES($1,$2,$3,$4,NULL)',[cup.id,targetId,request.targetName,temporary]);
   await q.query('UPDATE mlg_bot.matches SET home=CASE WHEN home=$2 THEN $3 ELSE home END,away=CASE WHEN away=$2 THEN $3 ELSE away END WHERE cup_id=$1 AND (home=$2 OR away=$2)',[cup.id,current!.user_id,targetId]);
   await q.query('DELETE FROM mlg_bot.cup_participants WHERE cup_id=$1 AND user_id=$2',[cup.id,current!.user_id]);
   await q.query('UPDATE mlg_bot.cup_participants SET position=$3,club=$4 WHERE cup_id=$1 AND user_id=$2',[cup.id,targetId,current!.position,current!.club]);
  }
  if(request.change==='incluir'&&cup.status==='open'&&people.rows.length+1===cup.size){
   const pool=await q.query<{name:string}>('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1 ORDER BY name',[request.group]);
   pool.rows=pool.rows.filter(p=>allowedDrawTeam(p.name,cup.team_kind));
   if(pool.rows.length<cup.size)throw Error('Draw pool changed during transaction');
   const players=await q.query<DrawRow>('SELECT user_id,display_name,club,position FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position',[cup.id]);
   const selected=shuffleDifferent(pool.rows.map(p=>p.name)).slice(0,cup.size);
   for(const [i,p] of players.rows.entries())await q.query('UPDATE mlg_bot.cup_participants SET club=$3 WHERE cup_id=$1 AND user_id=$2',[cup.id,p.user_id,selected[i]]);
   const order=shuffleDifferent(players.rows.map(p=>p.user_id));
   const counter=await q.query<{next:string}>("SELECT next_code::text AS next FROM mlg_bot.counters WHERE id='match' FOR UPDATE");
   const first=Number(counter.rows[0]?.next);if(!Number.isSafeInteger(first)||first+cup.size/2>Number.MAX_SAFE_INTEGER)throw Error('Match counter unavailable');
   for(let i=0;i<cup.size/2;i++)await q.query("INSERT INTO mlg_bot.matches(code,cup_id,round,position,home,away,status) VALUES($1,$2,0,$3,$4,$5,'scheduled')",[first+i,cup.id,i,order[i*2],order[i*2+1]]);
   await q.query("UPDATE mlg_bot.counters SET next_code=$1 WHERE id='match'",[first+cup.size/2]);
   await q.query("UPDATE mlg_bot.cups SET status='playing' WHERE id=$1",[cup.id]);cup.status='playing';
  }
  const after=await q.query<DrawRow>('SELECT user_id,display_name,club,position FROM mlg_bot.cup_participants WHERE cup_id=$1 ORDER BY position',[cup.id]);
  const games=await q.query<DrawMatch>('SELECT code::float8 AS code,home,away,round,position,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY round,position',[cup.id]);
  await q.query('INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,occurred_at,action,before_state,after_state,outcome) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',[actor,request.group,cup.id,Date.now(),'roster-'+request.change,JSON.stringify({...before,reason:request.reason}),JSON.stringify({participants:after.rows,matches:games.rows}),'accepted']);
  await checkpointCup(q,request.group,cup.id,actor,eventId+'-after');
  await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',['mlg-control-panel','Painel MLG']);
  const detail=request.change==='incluir'?request.targetName+' entrou na Copa.':request.change==='retirar'?current!.display_name+' saiu da Copa.':current!.display_name+' foi substituído por '+request.targetName+'.';
  const messageId='panel-'+randomUUID();await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4)',[request.group,'mlg-control-panel',messageId,Date.now()]);
  const newlyDrawn=request.change==='incluir'&&cup.status==='playing';
  const draw= newlyDrawn?'\n\n🎲 SORTEIO REALIZADO\n'+games.rows.map(m=>{const home=after.rows.find(p=>p.user_id===m.home)!,away=after.rows.find(p=>p.user_id===m.away)!;return `Lado ${m.position<cup.size/4?'A':'B'} · jogo ${m.code}: ${home.display_name} (${teamLabel(home.club,cup.team_kind)}) × ${away.display_name} (${teamLabel(away.club,cup.team_kind)})`;}).join('\n'):'';
  const notice='📋 ELENCO ATUALIZADO · '+cup.competition_name+'\n'+detail+'\nMotivo: '+request.reason+'\n\n'+(newlyDrawn?'Última vaga preenchida: seleções e confrontos sorteados agora.':cup.status==='playing'?'A seleção e o código da partida foram mantidos. Confira o jogo com !copa.':'Inscrições: '+after.rows.length+'/'+cup.size+'. A chave será sorteada quando completar as vagas.')+draw+'\n🛡️ Alteração e estado anterior salvos no banco.';
  await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[request.group,'mlg-control-panel',messageId,notice]);
  return {changed:true,cupId:cup.id,name:cup.competition_name,size:cup.size,status:cup.status,participants:after.rows};
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
    await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING', [event.userId,event.name.slice(0,60)]);
    const claimed = await q.query<{ message_id: string }>(`INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id`, [event.groupId,event.userId,event.id,event.at]);
    if (!claimed.rows.length) return { duplicate: true, notices: [] };
    const blocked=await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[event.userId]);
    if(blocked.rows.length)return {duplicate:false,notices:[]};
    // Read-only commands and ordinary registrations need no cross-group lock.
    // Commands that can allocate a match lock the counter before loading state.
    const mayAllocate=/^!(?:entrar|confirmar|resolver|forcarresultado|forcar|forçar)(?:\s|$)/i.test(event.text.trim());
    const counter = await q.query<{ next: string }>("SELECT next_code::text AS next FROM mlg_bot.counters WHERE id='match'"+(mayAllocate?' FOR UPDATE':''));
    if (!counter.rows[0]) throw new Error('Migration required: missing match counter');
    const state = emptyState(); state.nextCode = Number(counter.rows[0].next);
    const admins = await q.query<{ id: string }>('SELECT DISTINCT a.user_id AS id FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE g.authorized AND g.admins_configured');
    const clubs = await q.query<{ name: string }>('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1 ORDER BY name', [event.groupId]);
    state.groups[event.groupId] = { authorized: true, admins: admins.rows.map(r => r.id), clubs: clubs.rows.map(r => r.name), competitionName:groups.rows[0]!.competitionName,teamKind:groups.rows[0]!.teamKind,formatSize:groups.rows[0]!.formatSize };
    const drafts = await q.query<{ ownerId: string; expiresAt: number }>('SELECT owner_id AS "ownerId",expires_at::float8 AS "expiresAt" FROM mlg_bot.command_drafts WHERE group_id=$1', [event.groupId]);
    if (drafts.rows[0]) state.drafts[event.groupId] = drafts.rows[0];
    const cups = await q.query<Omit<Cup,'participants'|'matches'>>(`SELECT id,group_id AS "groupId",created_by AS "createdBy",created_at::float8 AS "createdAt",
      size,competition_name AS "competitionName",team_kind AS "teamKind",status,champion,completed_at::float8 AS "completedAt",cancellation_reason AS "cancellationReason" FROM mlg_bot.cups WHERE group_id=$1 ORDER BY created_at,id`, [event.groupId]);
    for (const row of cups.rows) state.cups[row.id]={ ...row, champion: row.champion ?? undefined, completedAt: row.completedAt ?? undefined, cancellationReason: row.cancellationReason ?? undefined, participants: [], matches: [] };
    const participants=await q.query<Participant&{cup_id:string}>(`SELECT p.cup_id,p.user_id AS "userId",p.display_name AS name,p.club
      FROM mlg_bot.cup_participants p JOIN mlg_bot.cups c ON c.id=p.cup_id
      WHERE c.group_id=$1 ORDER BY c.created_at,c.id,p.position`,[event.groupId]);
    for(const {cup_id,...p} of participants.rows)state.cups[cup_id]?.participants.push({...p,club:p.club??undefined});
    const matches=await q.query<Omit<Match,'results'>&{cup_id:string}>(`SELECT m.cup_id,m.code::float8 AS code,m.round,m.position,m.home,m.away,m.winner,m.status
      FROM mlg_bot.matches m JOIN mlg_bot.cups c ON c.id=m.cup_id
      WHERE c.group_id=$1 ORDER BY c.created_at,c.id,m.round,m.position`,[event.groupId]);
    const byCode=new Map<number,Match>();
    for(const {cup_id,...m} of matches.rows){const match:Match={...m,winner:m.winner??undefined,results:[]};state.cups[cup_id]?.matches.push(match);byCode.set(match.code,match);}
    const results=await q.query<Result&{match_code:number}>(`SELECT r.match_code::float8 AS match_code,r.home,r.away,r.author,r.created_at::float8 AS at,r.status,
      r.confirmed_by AS "confirmedBy",r.disputed_by AS "disputedBy",r.reason
      FROM mlg_bot.match_results r JOIN mlg_bot.matches m ON m.code=r.match_code JOIN mlg_bot.cups c ON c.id=m.cup_id
      WHERE c.group_id=$1 ORDER BY r.match_code,r.revision`,[event.groupId]);
    for(const {match_code,...r} of results.rows)byCode.get(match_code)?.results.push({...r,confirmedBy:r.confirmedBy??undefined,disputedBy:r.disputedBy??undefined,reason:r.reason??undefined});
    const savedProfiles=await q.query<{userId:string;name:string}>('SELECT user_id AS "userId",display_name AS name FROM mlg_bot.coach_profiles WHERE group_id=$1',[event.groupId]);
    const names=await q.query<{userId:string;name:string}>(`SELECT u.id AS "userId",COALESCE(p.display_name,u.display_name) AS name
      FROM mlg_bot.users u LEFT JOIN mlg_bot.coach_profiles p ON p.group_id=$1 AND p.user_id=u.id
      WHERE u.id=$2 OR p.user_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM mlg_bot.cup_participants cp JOIN mlg_bot.cups c ON c.id=cp.cup_id WHERE c.group_id=$1 AND cp.user_id=u.id)`,[event.groupId,event.userId]);
    state.profiles={[event.groupId]:Object.fromEntries(names.rows.map(p=>[p.userId,p.name]))};
    for(const cup of Object.values(state.cups))for(const participant of cup.participants){
      if(state.profiles[event.groupId]?.[participant.userId])participant.name=state.profiles[event.groupId]![participant.userId]!;
    }
    const output = apply(state,event,env);
    const joined=Object.values(output.state.cups).some(c=>c.groupId===event.groupId&&c.participants.some(p=>p.userId===event.userId&&!state.cups[c.id]?.participants.some(old=>old.userId===event.userId)));
    for(const [id,name] of Object.entries(output.state.profiles?.[event.groupId]??{})){
      const changed=state.profiles[event.groupId]?.[id]!==name;
      if(!changed&&!(joined&&id===event.userId))continue;
      await q.query('INSERT INTO mlg_bot.coach_profiles(group_id,user_id,display_name) VALUES($1,$2,$3) ON CONFLICT(group_id,user_id) DO UPDATE SET display_name=excluded.display_name',[event.groupId,id,name]);
      if(changed){
        await q.query('UPDATE mlg_bot.users SET display_name=$2 WHERE id=$1',[id,name]);
        await q.query('UPDATE mlg_bot.coach_profiles SET display_name=$2 WHERE user_id=$1',[id,name]);
      }
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
          ON CONFLICT(cup_id,user_id) DO UPDATE SET club=excluded.club,display_name=excluded.display_name`, [cup.id,p.userId,p.name,position,p.club ?? null]);
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
    if(output.state.nextCode!==state.nextCode){
      if(!mayAllocate)throw Error('Match allocation requires counter lock');
      await q.query("UPDATE mlg_bot.counters SET next_code=$1 WHERE id='match'", [output.state.nextCode]);
    }
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
