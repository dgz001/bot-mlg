import {minicampClubs} from './clubs.ts';
// Private server-to-server gateway. Inject only a token digest during deployment.
import {Pool} from 'npm:pg@8.23.0';
import {randomUUID} from 'node:crypto';
import {pgDatabase,processEvent,autoConfirmDue,checkpointCup,cupDraw,cupRoster,cupRerollTeam} from './postgres.ts';
import {memberCommand} from './member-commands.ts';
import {guestOpen,guestEvent,guestAutoConfirm,guestArchive} from './guest-competition.ts';
const EXPECTED_DIGEST='__DIGEST__';
const pool=new Pool({connectionString:Deno.env.get('SUPABASE_DB_URL'),max:2,connectionTimeoutMillis:8000});
const base=pgDatabase(pool);
const db={transaction:run=>base.transaction(async q=>{await q.query('SET LOCAL ROLE mlg_bot_gateway');return run(q);})};
const jid=/^[0-9]+@(lid|s\.whatsapp\.net)$/;
const groupId=/^[0-9-]+@g\.us$/;
function validAliases(v){return Array.isArray(v)&&v.length>=1&&v.length<=2&&v.every(x=>typeof x==='string'&&jid.test(x));}
function validCompetition(body){return typeof body.name==='string'&&body.name.trim().length>=3&&body.name.length<=60&&['clube','seleção','misto'].includes(body.teamKind)&&Array.isArray(body.teams)&&body.teams.length>=4&&body.teams.length<=200&&body.teams.every(t=>typeof t==='string'&&t.length>=2&&t.length<=60&&t.trim()===t&&!/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(t))&&new Set(body.teams.map(t=>t.toLocaleLowerCase('pt-BR'))).size===body.teams.length;}
const templateId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const panelActor='mlg-control-panel';
async function panelNotice(q,group,message){
 const id='panel-'+randomUUID();
 await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[panelActor,'Painel MLG']);
 await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4)',[group,panelActor,id,Date.now()]);
 await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[group,panelActor,id,message]);
}
async function identity(q,aliases,name=null){
 if(!validAliases(aliases))throw Error('Invalid identity');
 await q.query('SELECT pg_advisory_xact_lock(71012027)');
 const existing=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[aliases]);
 if(existing.rows.length>1)throw Error('Identity conflict');
 const id=existing.rows[0]?.user_id??randomUUID();
 await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[id,(name??'Participante').slice(0,60)]);
 for(const alias of aliases)await q.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[alias,id]);
 return id;
}
async function finish(row,body){
 await db.transaction(async q=>{
 const r=await q.query('INSERT INTO mlg_bot.processed_messages VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id',[row.group_id,row.user_id,row.message_id,Number(row.received_at)]);
 if(r.rows.length)await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[row.group_id,row.user_id,row.message_id,body]);
 await q.query("UPDATE mlg_bot.inbox SET status='done',body='' WHERE id=$1",[row.id]);
 });
}
async function processInbox(){
 const rows=await db.transaction(q=>q.query("SELECT * FROM mlg_bot.inbox WHERE status='pending' ORDER BY id LIMIT 8"));
 for(const row of rows.rows){
  try{await processEvent(db,{id:row.message_id,groupId:row.group_id,userId:row.user_id,name:row.display_name,text:row.body,at:Number(row.received_at)});
   await db.transaction(q=>q.query("UPDATE mlg_bot.inbox SET status='done',body='' WHERE id=$1",[row.id]));
  }catch(e){if(e?.code)throw e;const msg=String(e?.message??'');const safe=/^(Somente|Não |Nenhum|Nenhuma|Já |Você |Grupo |Partida |Resultado |Copa |Mata-mata|Formato:|Informe|Código |Inscrições|Escolha |Nome |Comando desconhecido)/.test(msg)?msg:'Comando não aceito. Confira os dados.';await finish(row,safe);}
 }
}
async function seasonState(q){
 const r=await q.query(`WITH ml_cups AS (SELECT id FROM mlg_bot.cups WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)) SELECT
  (SELECT count(*)::int FROM ml_cups) AS cups,
  (SELECT count(*)::int FROM mlg_bot.cups c JOIN ml_cups x ON x.id=c.id WHERE c.status IN ('open','playing')) AS active,
  (SELECT count(*)::int FROM mlg_bot.cup_participants p JOIN ml_cups x ON x.id=p.cup_id) AS participants,
  (SELECT count(*)::int FROM mlg_bot.matches m JOIN ml_cups x ON x.id=m.cup_id) AS matches,
  (SELECT count(*)::int FROM mlg_bot.match_results r JOIN mlg_bot.matches m ON m.code=r.match_code JOIN ml_cups x ON x.id=m.cup_id) AS results,
  (SELECT count(*)::int FROM mlg_bot.match_results r JOIN mlg_bot.matches m ON m.code=r.match_code JOIN ml_cups x ON x.id=m.cup_id WHERE r.status='confirmed') AS confirmed,
  (SELECT count(*)::int FROM mlg_bot.command_drafts WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)) AS drafts,
  (SELECT coalesce(max(id),0)::text FROM mlg_bot.audit_logs WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)) AS last_audit,
  (SELECT coalesce(max(id),0)::text FROM mlg_bot.control_audit WHERE action='season-reset') AS last_reset`);
 const state=r.rows[0];return {...state,season:1+Number(await q.query("SELECT count(*)::int AS total FROM mlg_bot.control_audit WHERE action='season-reset'").then(x=>x.rows[0].total)),fingerprint:JSON.stringify(state)};
}
async function verifiedSeasonActor(q,source,aliases){
 const actor=await identity(q,aliases);
 const permission=await q.query(`SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups own ON own.id=a.group_id
  JOIN mlg_bot.groups source ON source.id=$2 WHERE a.user_id=$1 AND own.authorized AND own.admins_configured
  AND source.authorized AND a.role IN ('owner','admin') AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks b WHERE b.user_id=a.user_id) LIMIT 1`,[actor,source]);
 return permission.rows.length?actor:null;
}
async function archiveLoanCups(){
 return db.transaction(async q=>{
  const group=await q.query(`SELECT g.id FROM mlg_bot.groups g JOIN mlg_bot.loan_groups l ON l.group_id=g.id
   WHERE EXISTS(SELECT 1 FROM mlg_bot.cups c WHERE c.group_id=g.id AND (c.status='cancelled' OR c.status='completed' AND c.completed_at<$1))
   ORDER BY g.id FOR UPDATE OF g SKIP LOCKED LIMIT 1`,[Date.now()-600_000]);
  if(!group.rows.length)return;
  const id=group.rows[0].id;
  // Wait until the champion announcement and all earlier messages have been
  // delivered. The ledger is committed together with deleting the details.
  const unsent=await q.query("SELECT 1 FROM mlg_bot.outbox WHERE group_id=$1 AND status<>'sent' LIMIT 1",[id]);
  if(unsent.rows.length)return;
  const cups=await q.query("SELECT id,status,champion,competition_name,completed_at FROM mlg_bot.cups WHERE group_id=$1 AND (status='cancelled' OR status='completed' AND completed_at<$2) ORDER BY created_at,id FOR UPDATE LIMIT 3",[id,Date.now()-600_000]);
  for(const cup of cups.rows){
   if(cup.status==='completed'){
    const winner=await q.query('SELECT display_name FROM mlg_bot.cup_participants WHERE cup_id=$1 AND user_id=$2',[cup.id,cup.champion]);
    if(!winner.rows.length)throw Error('Missing loan champion');
    const number=await q.query('SELECT count(*)::int+1 AS edition FROM mlg_bot.loan_champions WHERE group_id=$1',[id]);
    await q.query(`INSERT INTO mlg_bot.loan_champions(cup_id,group_id,champion_id,champion_name,competition_name,edition,completed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(cup_id) DO NOTHING`,[cup.id,id,cup.champion,winner.rows[0].display_name,cup.competition_name,number.rows[0].edition,cup.completed_at]);
   }
   await q.query('DELETE FROM mlg_bot.audit_logs WHERE cup_id=$1',[cup.id]);
   await q.query('DELETE FROM mlg_bot.cup_checkpoints WHERE cup_id=$1',[cup.id]);
   await q.query('DELETE FROM mlg_bot.match_results WHERE match_code IN (SELECT code FROM mlg_bot.matches WHERE cup_id=$1)',[cup.id]);
   await q.query('DELETE FROM mlg_bot.matches WHERE cup_id=$1',[cup.id]);
   await q.query("UPDATE mlg_bot.cups SET status='cancelled',champion=NULL,completed_at=NULL WHERE id=$1 AND status='completed'",[cup.id]);
   await q.query('DELETE FROM mlg_bot.cup_participants WHERE cup_id=$1',[cup.id]);
   await q.query('DELETE FROM mlg_bot.cups WHERE id=$1',[cup.id]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('loan-archived',$1)",[id]);
  }
 });
}
Deno.serve(async req=>{
 const header=req.headers.get('authorization')??'';
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(header)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(digest!==EXPECTED_DIGEST)return new Response('Unauthorized',{status:401});
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 try{
 const raw=await req.text();if(raw.length>120000)return new Response('Too large',{status:413});
 const body=JSON.parse(raw);let result={};
 if(body.action==='health'){await db.transaction(q=>q.query('SELECT 1'));result={database:true};}
 else if(body.action==='guest-open')result=await guestOpen(db,body);
 else if(body.action==='guest-event'){
  if(!validAliases(body.aliases))throw Error('Invalid guest identity');
  result=await guestEvent(db,body,identity);
 }
 else if(body.action==='guest-status'||body.action==='guest-cancel'){
  if(!groupId.test(body.group))throw Error('Invalid guest group');
  result=await db.transaction(async q=>{
   const loan=await q.query('SELECT 1 FROM mlg_bot.loan_groups WHERE group_id=$1 AND active',[body.group]);
   if(!loan.rows.length)return {error:'Empréstimo não está ativo.'};
   await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[body.group]);
   const c=await q.query("SELECT * FROM mlg_bot.guest_competitions WHERE group_id=$1 AND status IN ('open','playing') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[body.group]);
   if(body.action==='guest-status')return {cup:c.rows[0]??null};
   if(!c.rows.length)return {error:'Nenhum campeonato em andamento.'};
   if(typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160)throw Error('Invalid cancellation reason');
   await q.query("UPDATE mlg_bot.guest_competitions SET status='cancelled' WHERE id=$1",[c.rows[0].id]);
   await panelNotice(q,body.group,'🚫 '+c.rows[0].name+' cancelado pelo organizador. Motivo: '+body.reason.trim());
   return {cancelled:true};
  });
 }
 else if(body.action==='season-preview'||body.action==='season-reset'){
  if(!groupId.test(body.source)||!validAliases(body.aliases)||body.action==='season-reset'&&(typeof body.messageId!=='string'||body.messageId.length<1||body.messageId.length>150||typeof body.fingerprint!=='string'||body.fingerprint.length>500))throw Error('Invalid season request');
  result=await db.transaction(async q=>{
   const actor=await verifiedSeasonActor(q,body.source,body.aliases);
   if(!actor)return {error:'Somente ADMs cadastrados em grupos autorizados podem reiniciar a temporada.'};
   if(body.action==='season-reset')await q.query('SELECT id FROM mlg_bot.groups WHERE authorized AND id NOT IN (SELECT group_id FROM mlg_bot.loan_groups) ORDER BY id FOR UPDATE');
   const current=await seasonState(q);
   if(body.action==='season-preview')return current;
   if(current.active)return {error:'Há Copa em andamento. Encerre ou cancele as edições antes de reiniciar.'};
   if(current.fingerprint!==body.fingerprint)return {error:'Os dados da temporada mudaram depois da revisão.'};
   // Delete dependent rows in one transaction; profiles, identities, groups,
   // moderation and tournament templates remain available for the new season.
   await q.query('DELETE FROM mlg_bot.outbox WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.inbox WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.processed_messages WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.command_rate WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.command_drafts WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.cup_checkpoints WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.audit_logs WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query('DELETE FROM mlg_bot.match_results WHERE match_code IN (SELECT m.code FROM mlg_bot.matches m JOIN mlg_bot.cups c ON c.id=m.cup_id WHERE c.group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups))');
   await q.query('DELETE FROM mlg_bot.matches WHERE cup_id IN (SELECT id FROM mlg_bot.cups WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups))');
   await q.query("UPDATE mlg_bot.cups SET status='cancelled',champion=NULL,completed_at=NULL WHERE champion IS NOT NULL AND group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)");
   await q.query('DELETE FROM mlg_bot.cup_participants WHERE cup_id IN (SELECT id FROM mlg_bot.cups WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups))');
   await q.query('DELETE FROM mlg_bot.cups WHERE group_id NOT IN (SELECT group_id FROM mlg_bot.loan_groups)');
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('season-reset',$1,$2)",[body.source,actor]);
   return {season:current.season+1,cups:current.cups,matches:current.matches};
  });
 }
 else if(body.action==='score-reaction'){
  if(!groupId.test(body.group)||typeof body.messageId!=='string'||body.messageId.length<1||body.messageId.length>150)throw Error('Invalid score message');
  result=await db.transaction(async q=>{
   const row=await q.query(`SELECT i.status AS inbox_status,r.status AS result_status,m.status AS match_status,
    (SELECT max(revision) FROM mlg_bot.match_results WHERE match_code=r.match_code) AS latest_revision,r.revision
    FROM mlg_bot.inbox i LEFT JOIN mlg_bot.match_results r ON r.author=i.user_id AND r.created_at=i.received_at
    LEFT JOIN mlg_bot.matches m ON m.code=r.match_code AND EXISTS(SELECT 1 FROM mlg_bot.cups c WHERE c.id=m.cup_id AND c.group_id=i.group_id)
    WHERE i.group_id=$1 AND i.message_id=$2 ORDER BY i.id DESC LIMIT 1`,[body.group,body.messageId]);
   const found=row.rows[0];
   return {status:!found||found.inbox_status==='pending'?'processing':found.inbox_status==='rejected'||!found.result_status?'rejected':found.result_status==='pending'?'pending':found.result_status==='confirmed'&&found.match_status==='confirmed'&&found.revision===found.latest_revision?'confirmed':'rejected'};
  });
 }
 else if(body.action==='control-check'){
  if(!groupId.test(body.group)||!validAliases(body.aliases))throw Error('Invalid control identity');
  result=await db.transaction(async q=>{
   const id=await identity(q,body.aliases);
   const allowed=await q.query("SELECT a.role,a.group_id FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND g.authorized AND g.admins_configured AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks b WHERE b.user_id=a.user_id)",[id]);
   const loan=await q.query('SELECT 1 FROM mlg_bot.loan_groups WHERE group_id=$1 AND manager_id=$2 AND active',[body.group,id]);
   const loanGroup=await q.query('SELECT 1 FROM mlg_bot.loan_groups WHERE group_id=$1 AND active',[body.group]);
   return {allowed:allowed.rows.some(a=>a.role==='owner'||a.role==='admin'),channelAllowed:allowed.rows.some(a=>a.group_id===body.group&&a.role==='channel'),loanAllowed:loanGroup.rows.length===1&&(loan.rows.length===1||allowed.rows.some(a=>a.group_id===body.group&&a.role==='channel')),loanGroup:loanGroup.rows.length===1};
  });
 }
 else if(body.action==='loan-private-check'){
  if(!validAliases(body.aliases))throw Error('Invalid private identity');
  result=await db.transaction(async q=>{
   const known=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[body.aliases]);
   if(known.rows.length!==1)return {allowed:false};
   const manager=known.rows[0].user_id;
   if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[manager])).rows.length)return {allowed:false};
   const invitation=await q.query('SELECT claimed_group,extract(epoch from granted_at)*1000 AS granted_at_ms FROM mlg_bot.loan_invitations WHERE manager_id=$1 AND active',[manager]);
   return invitation.rows.length?{allowed:true,manager,claimedGroup:invitation.rows[0].claimed_group??null,grantedAt:Number(invitation.rows[0].granted_at_ms)}:{allowed:false};
  });
 }
 else if(body.action==='loan-invite'){
  if(!groupId.test(body.source)||!validAliases(body.aliases)||!['get','grant','revoke'].includes(body.operation)||body.operation!=='get'&&!validAliases(body.targetAliases))throw Error('Invalid invitation');
  result=await db.transaction(async q=>{
   const actor=await verifiedSeasonActor(q,body.source,body.aliases);
   if(!actor)return {error:'Somente ADMs gerais da MLG podem emprestar o bot.'};
   if(body.operation==='get'){
    const rows=await q.query(`SELECT u.display_name AS name,l.active,l.claimed_group,w.jid FROM mlg_bot.loan_invitations l
     JOIN mlg_bot.users u ON u.id=l.manager_id LEFT JOIN LATERAL
     (SELECT jid FROM mlg_bot.wa_identities WHERE user_id=l.manager_id AND jid LIKE '%@s.whatsapp.net' LIMIT 1) w ON true
     WHERE l.active ORDER BY l.granted_at DESC LIMIT 30`);
    return {invitations:rows.rows};
   }
   if(body.operation==='revoke'){
    const found=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[body.targetAliases]);
    if(found.rows.length!==1)return {error:'Convite não encontrado.'};
    const invite=await q.query('SELECT claimed_group FROM mlg_bot.loan_invitations WHERE manager_id=$1 AND active FOR UPDATE',[found.rows[0].user_id]);
    if(!invite.rows.length)return {error:'Não há convite ativo para este número.'};
    if(invite.rows[0].claimed_group)return {error:'Este convite já está em uso. Selecione o grupo com !usar e envie !devolverbot.'};
    await q.query('UPDATE mlg_bot.loan_invitations SET active=false,revoked_at=now() WHERE manager_id=$1',[found.rows[0].user_id]);
    return {revoked:true};
   }
   const manager=await identity(q,body.targetAliases);
   if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[manager])).rows.length)return {error:'Esta pessoa está bloqueada.'};
   const existing=await q.query('SELECT claimed_group,active FROM mlg_bot.loan_invitations WHERE manager_id=$1 FOR UPDATE',[manager]);
   // Retrying sends the guide again without resetting a claimed group.
   if(existing.rows[0]?.active)return {invited:true,existing:true};
   await q.query(`INSERT INTO mlg_bot.loan_invitations(manager_id,granted_by) VALUES($1,$2)
    ON CONFLICT(manager_id) DO UPDATE SET granted_by=excluded.granted_by,active=true,granted_at=now(),claimed_group=NULL,revoked_at=NULL`,[manager,actor]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,user_id) VALUES('loan-invited',$1)",[manager]);
   return {invited:true};
  });
 }
 else if(body.action==='loan-claim'){
  if(!groupId.test(body.group)||!validAliases(body.aliases))throw Error('Invalid claim');
  result=await db.transaction(async q=>{
   const manager=await identity(q,body.aliases,body.name);
   if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[manager])).rows.length)return {error:'Esta pessoa está bloqueada no bot.'};
   const invitation=await q.query('SELECT claimed_group FROM mlg_bot.loan_invitations WHERE manager_id=$1 AND active FOR UPDATE',[manager]);
   if(!invitation.rows.length)return {error:'Não há convite ativo para este administrador. Peça a um ADM geral para enviar !emprestar telefone.'};
   if(invitation.rows[0].claimed_group&&invitation.rows[0].claimed_group!==body.group)return {error:'Este empréstimo já pertence a outro grupo.'};
   const existing=await q.query('SELECT id,authorized FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[body.group]);
   if(existing.rows.length&&!invitation.rows[0].claimed_group)return {error:'O grupo já possui configuração da MLG. Use um grupo novo para o empréstimo.'};
   if(!existing.rows.length){
    await q.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured,competition_name,team_kind) VALUES($1,true,true,'Campeonato convidado','clube')",[body.group]);
    for(const team of minicampClubs)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[body.group,team]);
   }
   if(!invitation.rows[0].claimed_group){
    await q.query('INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) SELECT $1,manager_id,granted_by FROM mlg_bot.loan_invitations WHERE manager_id=$2',[body.group,manager]);
    await q.query('UPDATE mlg_bot.loan_invitations SET claimed_group=$2 WHERE manager_id=$1',[manager,body.group]);
    await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'channel') ON CONFLICT DO NOTHING",[body.group,manager]);
    await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('loan-claimed',$1,$2)",[body.group,manager]);
   }
   return {claimed:true};
  });
 }
 else if(body.action==='loan-manage'){
  if(!groupId.test(body.source)||!groupId.test(body.group)||!validAliases(body.aliases)||!['get','grant','revoke'].includes(body.operation)||body.operation==='grant'&&!validAliases(body.targetAliases))throw Error('Invalid loan request');
  result=await db.transaction(async q=>{
   const actor=await verifiedSeasonActor(q,body.source,body.aliases);
   if(!actor)return {error:'Somente ADMs gerais da MLG podem emprestar o bot.'};
   const g=await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);
   if(!g.rows.length)return {error:'Autorize primeiro o grupo convidado no painel e selecione-o com !usar.'};
   const existing=await q.query(`SELECT l.manager_id,l.active,u.display_name AS name FROM mlg_bot.loan_groups l
    JOIN mlg_bot.users u ON u.id=l.manager_id WHERE l.group_id=$1`,[body.group]);
   if(body.operation==='get')return {loan:existing.rows[0]??null};
   const live=await q.query("SELECT 1 FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') UNION SELECT 1 FROM mlg_bot.guest_competitions WHERE group_id=$1 AND status IN ('open','playing') LIMIT 1",[body.group]);
   if(live.rows.length)return {error:'Encerre ou cancele a Copa ativa neste grupo antes de alterar o empréstimo.'};
   if(body.operation==='revoke'){
    if(!existing.rows[0]?.active)return {error:'Não há empréstimo ativo neste grupo.'};
    await q.query('UPDATE mlg_bot.loan_groups SET active=false,revoked_at=now() WHERE group_id=$1',[body.group]);
    await q.query('UPDATE mlg_bot.loan_invitations SET active=false,revoked_at=now() WHERE claimed_group=$1',[body.group]);
    await q.query("DELETE FROM mlg_bot.admins WHERE group_id=$1 AND role='channel'",[body.group]);
    await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('loan-revoked',$1,$2)",[body.group,actor]);
    return {revoked:true};
   }
   const previous=await q.query('SELECT 1 FROM mlg_bot.cups WHERE group_id=$1 LIMIT 1',[body.group]);
   if(previous.rows.length&&!existing.rows.length)return {error:'Este grupo já tem histórico da MLG. Use um canal novo para manter as comunidades separadas.'};
   const manager=await identity(q,body.targetAliases);
   const blocked=await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[manager]);
   if(blocked.rows.length)return {error:'Esta pessoa está bloqueada no bot.'};
   if(existing.rows[0]?.active&&existing.rows[0].manager_id!==manager)return {error:'Já há outro responsável. Encerre o empréstimo anterior primeiro.'};
   await q.query(`INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,$2,$3)
    ON CONFLICT(group_id) DO UPDATE SET manager_id=excluded.manager_id,granted_by=excluded.granted_by,active=true,granted_at=now(),revoked_at=NULL`,[body.group,manager,actor]);
   await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'channel') ON CONFLICT(group_id,user_id) DO NOTHING",[body.group,manager]);
   await q.query('UPDATE mlg_bot.groups SET admins_configured=true WHERE id=$1',[body.group]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('loan-granted',$1,$2)",[body.group,actor]);
   return {granted:true,name:existing.rows[0]?.name??'Responsável'};
  });
 }
 else if(body.action==='guest-admin'){
  if(!groupId.test(body.group)||!validAliases(body.aliases)||!['list','grant','revoke'].includes(body.operation)||body.operation!=='list'&&!validAliases(body.targetAliases))throw Error('Invalid guest ADM request');
  result=await db.transaction(async q=>{
   const actor=await identity(q,body.aliases);
   const loan=await q.query('SELECT manager_id FROM mlg_bot.loan_groups WHERE group_id=$1 AND active FOR UPDATE',[body.group]);
   if(!loan.rows.length)return {error:'Empréstimo não está ativo neste grupo.'};
   if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[actor])).rows.length)return {error:'Conta bloqueada.'};
   const manager=loan.rows[0].manager_id;
   const global=(await q.query("SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND a.role IN ('owner','admin') AND g.authorized AND g.admins_configured LIMIT 1",[actor])).rows.length>0;
   if(body.operation==='list'){
    if(actor!==manager&&!global&&!(await q.query("SELECT 1 FROM mlg_bot.admins WHERE group_id=$1 AND user_id=$2 AND role='channel'",[body.group,actor])).rows.length)return {error:'Sem acesso a este grupo.'};
    const rows=await q.query(`SELECT w.jid,CASE WHEN a.user_id=$2 THEN 'manager' ELSE 'channel' END AS role
     FROM mlg_bot.admins a LEFT JOIN LATERAL(SELECT jid FROM mlg_bot.wa_identities WHERE user_id=a.user_id AND jid LIKE '%@s.whatsapp.net' ORDER BY jid LIMIT 1) w ON true
     WHERE a.group_id=$1 AND (a.role='channel' OR a.user_id=$2) ORDER BY role,w.jid LIMIT 100`,[body.group,manager]);
    return {admins:rows.rows};
   }
   if(actor!==manager&&!global)return {error:'Só o organizador deste grupo pode alterar auxiliares.'};
   const found=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[body.targetAliases]);
   if(found.rows.length>1)return {error:'Contas conflitantes. Confira o número.'};
   if(body.operation==='revoke'&&!found.rows.length)return {error:'Número não cadastrado.'};
   const target=found.rows[0]?.user_id??await identity(q,body.targetAliases);
   if(target===manager)return {error:'O organizador principal é definido pelo empréstimo da MLG.'};
   if(body.operation==='grant'){
    if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[target])).rows.length)return {error:'Conta bloqueada.'};
    await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'channel') ON CONFLICT DO NOTHING",[body.group,target]);
   }else{
    const removed=await q.query("DELETE FROM mlg_bot.admins WHERE group_id=$1 AND user_id=$2 AND role='channel' RETURNING user_id",[body.group,target]);
    if(!removed.rows.length)return {error:'Esta pessoa não é auxiliar deste grupo.'};
   }
   await q.query('INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES($1,$2,$3)',[body.operation==='grant'?'guest-admin-granted':'guest-admin-revoked',body.group,actor]);
   return {updated:true};
  });
 }
 else if(body.action==='admin-access'){
  if(!groupId.test(body.source)||!groupId.test(body.group)||!validAliases(body.aliases)||!['list','grant','revoke'].includes(body.operation)||body.operation!=='list'&&(!validAliases(body.targetAliases)||body.operation==='grant'&&!['admin','channel'].includes(body.role)))throw Error('Invalid ADM access');
  result=await db.transaction(async q=>{
   const actor=await verifiedSeasonActor(q,body.source,body.aliases);
   if(!actor)return {error:'Somente um ADM geral pode gerenciar permissões.'};
   await q.query('SELECT pg_advisory_xact_lock(71012028)');
   const group=await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);
   if(!group.rows.length)return {error:'Canal não autorizado.'};
   if(body.operation==='list'){
    const rows=await q.query(`SELECT u.display_name AS name,a.role,w.jid FROM mlg_bot.admins a JOIN mlg_bot.users u ON u.id=a.user_id
     LEFT JOIN LATERAL(SELECT jid FROM mlg_bot.wa_identities WHERE user_id=a.user_id AND jid LIKE '%@s.whatsapp.net' ORDER BY jid LIMIT 1) w ON true
     WHERE a.group_id=$1 ORDER BY a.role,u.display_name LIMIT 30`,[body.group]);
    return {admins:rows.rows};
   }
   // An existing identity must be used for revocation; do not create a new
   // account merely because an ADM entered a different phone number.
   const found=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[body.targetAliases]);
   if(found.rows.length>1)return {error:'Contas conflitantes. Confirme o número no painel.'};
   if(body.operation==='revoke'&&!found.rows.length)return {error:'Esse número não está cadastrado.'};
   const target=found.rows[0]?.user_id??await identity(q,body.targetAliases);
   if(body.operation==='revoke'){
    const current=await q.query('SELECT role FROM mlg_bot.admins WHERE group_id=$1 AND user_id=$2',[body.group,target]);
    if(!current.rows.length)return {error:'Essa pessoa não é ADM deste canal.'};
    if(current.rows[0].role==='owner')return {error:'O dono deve ajustar sua permissão pelo painel.'};
    const global=await q.query("SELECT count(*)::int AS total FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE g.authorized AND g.admins_configured AND a.role IN ('owner','admin')");
    if(current.rows[0].role==='admin'&&global.rows[0].total<=1)return {error:'Não é possível remover o último ADM geral.'};
    await q.query('DELETE FROM mlg_bot.admins WHERE group_id=$1 AND user_id=$2',[body.group,target]);
   }else{
    const existing=await q.query('SELECT role FROM mlg_bot.admins WHERE group_id=$1 AND user_id=$2',[body.group,target]);
    if(existing.rows[0]?.role==='owner')return {error:'A permissão do dono não pode ser reduzida por comando.'};
    if(existing.rows[0]?.role==='admin'&&body.role==='channel'){
     const global=await q.query("SELECT count(*)::int AS total FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE g.authorized AND g.admins_configured AND a.role IN ('owner','admin')");
     if(global.rows[0].total<=1)return {error:'Não é possível reduzir o último ADM geral.'};
    }
    await q.query(`INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,$3)
     ON CONFLICT(group_id,user_id) DO UPDATE SET role=excluded.role`,[body.group,target,body.role]);
    await q.query('UPDATE mlg_bot.groups SET admins_configured=true WHERE id=$1',[body.group]);
   }
   await q.query('INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES($1,$2,$3)',['whatsapp-admin-'+body.operation,body.group,actor]);
   return {updated:true,role:body.role};
  });
 }
 else if(body.action==='block-check'){
  if(!validAliases(body.aliases))throw Error('Invalid member identity');
  result=await db.transaction(async q=>{
   const match=await q.query('SELECT 1 FROM mlg_bot.member_blocks b JOIN mlg_bot.wa_identities w ON w.user_id=b.user_id WHERE w.jid=ANY($1::text[]) LIMIT 1',[body.aliases]);
   return {blocked:match.rows.length>0};
  });
 }
 else if(body.action==='admin-cup-command'){
  if(!groupId.test(body.source)||!groupId.test(body.group)||!validAliases(body.aliases)||typeof body.messageId!=='string'||body.messageId.length<1||body.messageId.length>128||typeof body.text!=='string'||body.text.length>250||!/^!(?:forcarresultado|resolver|deletar|vistoria)(?:\s|$)/i.test(body.text))throw Error('Invalid remote ADM command');
  const permission=await db.transaction(async q=>{
   const actor=await identity(q,body.aliases);
   const allowed=await q.query(`SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups configured ON configured.id=a.group_id
    JOIN mlg_bot.groups source ON source.id=$2 JOIN mlg_bot.groups target ON target.id=$3
    WHERE a.user_id=$1 AND a.role IN ('owner','admin') AND configured.authorized AND configured.admins_configured AND source.authorized AND target.authorized
      AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks b WHERE b.user_id=a.user_id) LIMIT 1`,[actor,body.source,body.group]);
   return allowed.rows.length?actor:null;
  });
  if(!permission){result={error:'Somente ADMs selecionados podem agir em grupos autorizados.'};}
  else{
   try{
    const event=await processEvent(db,{id:'remote-'+body.source+'-'+body.messageId,groupId:body.group,userId:permission,name:'ADM',text:body.text,at:Date.now()});
    result={accepted:true,duplicate:event.duplicate};
   }catch(error){
    if(error?.code)throw error;
    const message=String(error?.message??'');
    result={error:/^(Somente|Não |Nenhum|Nenhuma|Já |Partida |Resultado |Copa |Formato:|Informe|Código )/.test(message)?message:'Comando não aceito. Confira o código, o motivo e a Copa escolhida.'};
   }
  }
 }
 else if(body.action==='member-block'){
  if(!groupId.test(body.group)||!validAliases(body.aliases)||body.operation!=='list'&&body.operation!=='block'&&body.operation!=='unblock'||body.operation!=='list'&&(!validAliases(body.targetAliases)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.reason)))throw Error('Invalid block request');
  result=await db.transaction(async q=>{
   const actor=await identity(q,body.aliases);
   const permission=await q.query("SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND a.role IN ('owner','admin') AND g.authorized AND g.admins_configured AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks b WHERE b.user_id=a.user_id) LIMIT 1",[actor]);
   if(!permission.rows.length)return {error:'Somente ADMs selecionados podem bloquear membros.'};
   if(body.operation==='list'){
    const rows=await q.query('SELECT u.display_name,b.reason FROM mlg_bot.member_blocks b JOIN mlg_bot.users u ON u.id=b.user_id ORDER BY b.blocked_at LIMIT 30');
    return {members:rows.rows};
   }
   const target=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[body.targetAliases]);
   if(target.rows.length!==1)return {error:'Conta não identificada. Marque um membro presente no grupo.'};
   const targetId=target.rows[0].user_id;
   if(targetId===actor)return {error:'Você não pode bloquear sua própria conta.'};
   if(body.operation==='block'){
    const adm=await q.query('SELECT 1 FROM mlg_bot.admins WHERE user_id=$1 LIMIT 1',[targetId]);
    if(adm.rows.length)return {error:'Retire primeiro a permissão de ADM dessa conta no painel.'};
    const active=await q.query("SELECT 1 FROM mlg_bot.cup_participants p JOIN mlg_bot.cups c ON c.id=p.cup_id WHERE p.user_id=$1 AND c.status IN ('open','playing') LIMIT 1",[targetId]);
    if(active.rows.length)return {error:'Membro em Copa ativa: faça a substituição ou termine a Copa antes de bloquear.'};
    const inserted=await q.query('INSERT INTO mlg_bot.member_blocks(user_id,blocked_by,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[targetId,actor,body.reason.trim()]);
    if(!inserted.rows.length)return {error:'Esta conta já está bloqueada.'};
   }else{
    const removed=await q.query('DELETE FROM mlg_bot.member_blocks WHERE user_id=$1 RETURNING user_id',[targetId]);
    if(!removed.rows.length)return {error:'Esta conta não está bloqueada.'};
   }
   await q.query('INSERT INTO mlg_bot.member_block_events(actor_id,target_id,action,reason) VALUES($1,$2,$3,$4)',[actor,targetId,body.operation,body.reason.trim()]);
   return {updated:true,operation:body.operation};
  });
 }
 else if(body.action==='cup-draw'){
  if(!groupId.test(body.group)||!groupId.test(body.controlGroup)||!validAliases(body.aliases)||body.mode!==undefined&&!['equipes','chave','completo'].includes(body.mode)||body.mode&&(typeof body.expected!=='string'||!/^[0-9a-f]{64}$/.test(body.expected)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.reason)))throw Error('Invalid draw request');
  result=await cupDraw(db,{group:body.group,controlGroup:body.controlGroup,actorAliases:body.aliases,mode:body.mode,expected:body.expected,reason:body.reason});
 }
 else if(body.action==='cup-reroll-team'){
  const byMention=validAliases(body.targetAliases),byName=typeof body.targetName==='string'&&body.targetName.trim().length>=2&&body.targetName.trim().length<=60&&!/[@|\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.targetName);
  if(!groupId.test(body.group)||!validAliases(body.aliases)||byMention===byName||typeof body.messageId!=='string'||body.messageId.length<1||body.messageId.length>128||/[\r\n\x00-\x1f\x7f]/.test(body.messageId)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.reason))throw Error('Invalid team replacement');
  result=await cupRerollTeam(db,{group:body.group,actorAliases:body.aliases,...(byMention?{targetAliases:body.targetAliases}:{targetName:body.targetName.trim()}),messageId:body.messageId,reason:body.reason.trim()});
 }
 else if(body.action==='cup-roster'){
  if(!groupId.test(body.group)||!groupId.test(body.controlGroup)||!validAliases(body.aliases)||body.change!==undefined&&(!['incluir','retirar','trocar'].includes(body.change)||typeof body.expected!=='string'||!/^[0-9a-f]{64}$/.test(body.expected)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.reason)||body.change!=='incluir'&&(!Number.isSafeInteger(body.position)||body.position<1||body.position>32)||body.change!=='retirar'&&(!validAliases(body.targetAliases)||typeof body.targetName!=='string'||body.targetName.trim().length<2||body.targetName.length>60||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.targetName))))throw Error('Invalid roster request');
  result=await cupRoster(db,{group:body.group,controlGroup:body.controlGroup,actorAliases:body.aliases,change:body.change,expected:body.expected,reason:body.reason,position:body.position,targetAliases:body.targetAliases,targetName:body.targetName});
 }
 else if(body.action==='configure'){
  if(!groupId.test(body.group)||!Array.isArray(body.admins)||body.admins.length<1||body.admins.length>100||!body.admins.every(validAliases)||!Array.isArray(body.clubs)||body.clubs.length<16||body.clubs.length>256||body.clubs.some(c=>typeof c!=='string'||c.length<2||c.length>60)||new Set(body.clubs).size!==body.clubs.length)throw Error('Invalid configuration');
  result=await db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(71012027)');
   const inserted=await q.query('INSERT INTO mlg_bot.groups(id,authorized) VALUES($1,true) ON CONFLICT DO NOTHING RETURNING id',[body.group]);
   if(!inserted.rows.length)return {configured:true,existing:true};
   
   for(const club of minicampClubs)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[body.group,club]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('bootstrap-verified-whatsapp-admins',$1)",[body.group]);
   return {configured:true};
  });
 }

 else if(body.action==='competition-get'){
  if(!groupId.test(body.group))throw Error('Invalid group');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT competition_name,team_kind,format_size FROM mlg_bot.groups WHERE id=$1 AND authorized',[body.group]);
   if(!g.rows.length)throw Error('Unauthorized group');
   const t=await q.query('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1 ORDER BY name',[body.group]);
   return {competition:{name:g.rows[0].competition_name,teamKind:g.rows[0].team_kind,formatSize:g.rows[0].format_size,teams:t.rows.map(r=>r.name)}};
  });
 }
 else if(body.action==='templates-list'){
  if(!groupId.test(body.group))throw Error('Invalid group');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT competition_name,team_kind,active_template_id FROM mlg_bot.groups WHERE id=$1 AND authorized',[body.group]);
   if(!g.rows.length)throw Error('Unauthorized group');
   const templates=await q.query('SELECT id,name,team_kind AS "teamKind",cardinality(teams) AS "teamCount",updated_at AS "updatedAt" FROM mlg_bot.competition_templates WHERE group_id=$1 ORDER BY lower(name)',[body.group]);
   const cup=await q.query("SELECT c.id,c.competition_name AS name,c.status,c.size,(SELECT count(*) FROM mlg_bot.cup_participants p WHERE p.cup_id=c.id) AS participants,(SELECT count(*) FROM mlg_bot.matches m WHERE m.cup_id=c.id AND m.status='pending') AS pending,(SELECT count(*) FROM mlg_bot.matches m WHERE m.cup_id=c.id AND m.status='disputed') AS disputed FROM mlg_bot.cups c WHERE c.group_id=$1 AND c.status IN ('open','playing') ORDER BY c.created_at DESC LIMIT 1",[body.group]);
   if(cup.rows[0]){
    const saved=await q.query('SELECT max(recorded_at)::float8 AS "checkpointAt",count(*)::int AS "checkpointCount" FROM mlg_bot.cup_checkpoints WHERE cup_id=$1',[cup.rows[0].id]);
    Object.assign(cup.rows[0],saved.rows[0]);
   }
   const history=await q.query(`SELECT id,name,status,size,edition FROM (
      SELECT id,competition_name AS name,status,size,created_at,
        row_number() OVER (PARTITION BY (status='cancelled') ORDER BY created_at,id) AS edition
      FROM mlg_bot.cups WHERE group_id=$1
    ) editions ORDER BY created_at DESC,id DESC LIMIT 15`,[body.group]);
   const nextEdition=await q.query("SELECT (SELECT count(*) FROM mlg_bot.cups WHERE group_id=$1 AND status<>'cancelled')::int+(SELECT count(*) FROM mlg_bot.loan_champions WHERE group_id=$1)::int+1 AS edition",[body.group]);
   const draft=await q.query('SELECT 1 FROM mlg_bot.command_drafts WHERE group_id=$1 AND expires_at>$2',[body.group,Date.now()]);
   return {templates:templates.rows,activeTemplateId:g.rows[0].active_template_id,activeCompetition:g.rows[0].competition_name,activeCup:cup.rows[0]??null,preparing:draft.rows.length>0,nextEdition:nextEdition.rows[0].edition,recentCups:history.rows};
  });
 }
 else if(body.action==='cup-open'){
  if(!groupId.test(body.group)||![4,8,16,32].includes(body.size)||body.proposal!==undefined&&!validCompetition(body.proposal))throw Error('Invalid cup');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT competition_name,team_kind,format_size,admins_configured FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);
   if(!g.rows.length)throw Error('Unauthorized group');
   if(!g.rows[0].admins_configured)return {error:'Selecione e salve os ADMs deste grupo antes de abrir a Copa.'};
   if(!body.proposal&&g.rows[0].format_size&&g.rows[0].format_size!==body.size)return {error:'Este grupo está configurado para '+g.rows[0].format_size+' vagas.'};
   const active=await q.query("SELECT 1 FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing')",[body.group]);
   if(active.rows.length)return {error:'Já existe uma Copa aberta neste grupo.'};
   const draft=await q.query('SELECT 1 FROM mlg_bot.command_drafts WHERE group_id=$1 AND expires_at>$2',[body.group,Date.now()]);
   if(draft.rows.length)return {error:'Há uma Copa em preparação pelo WhatsApp. Conclua ou cancele o comando antes de abrir outra.'};
   if(body.proposal){
    if(body.proposal.teams.length<body.size)return {error:'A lista precisa ter pelo menos '+body.size+' times.'};
    const chosen=await q.query('SELECT id FROM mlg_bot.competition_templates WHERE group_id=$1 AND lower(name)=lower($2)',[body.group,body.proposal.name.trim()]);
    const template=chosen.rows.length?await q.query('UPDATE mlg_bot.competition_templates SET name=$3,team_kind=$4,teams=$5,updated_at=now() WHERE group_id=$1 AND id=$2 RETURNING id',[body.group,chosen.rows[0].id,body.proposal.name.trim(),body.proposal.teamKind,body.proposal.teams]):await q.query('INSERT INTO mlg_bot.competition_templates(group_id,name,team_kind,teams) VALUES($1,$2,$3,$4) RETURNING id',[body.group,body.proposal.name.trim(),body.proposal.teamKind,body.proposal.teams]);
    await q.query('UPDATE mlg_bot.groups SET competition_name=$2,team_kind=$3,format_size=NULL,active_template_id=$4 WHERE id=$1',[body.group,body.proposal.name.trim(),body.proposal.teamKind,template.rows[0].id]);
    await q.query('DELETE FROM mlg_bot.club_pool WHERE group_id=$1',[body.group]);
    for(const team of body.proposal.teams)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[body.group,team]);
    g.rows[0].competition_name=body.proposal.name.trim();g.rows[0].team_kind=body.proposal.teamKind;
   }else{
    const poolSize=await q.query('SELECT count(*)::int AS total FROM mlg_bot.club_pool WHERE group_id=$1',[body.group]);
    if(poolSize.rows[0].total<body.size)return {error:'O modelo ativo precisa ter pelo menos '+body.size+' times.'};
   }
   await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[panelActor,'Painel MLG']);
   const number=await q.query("SELECT (SELECT count(*) FROM mlg_bot.cups WHERE group_id=$1 AND status<>'cancelled')::int+(SELECT count(*) FROM mlg_bot.loan_champions WHERE group_id=$1)::int+1 AS edition",[body.group]);
   const id=randomUUID(),at=Date.now();
   await q.query("INSERT INTO mlg_bot.cups(id,group_id,created_by,created_at,size,status,competition_name,team_kind) VALUES($1,$2,$3,$4,$5,'open',$6,$7)",[id,body.group,panelActor,at,body.size,g.rows[0].competition_name,g.rows[0].team_kind]);
   await checkpointCup(q,body.group,id,panelActor,'panel-'+randomUUID());
   await q.query("INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,occurred_at,action,before_state,after_state,outcome) VALUES($1,$2,$3,$4,'panel-open',NULL,$5::jsonb,'accepted')",[panelActor,body.group,id,at,JSON.stringify({size:body.size,name:g.rows[0].competition_name})]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('panel-open-cup',$1,$2)",[body.group,panelActor]);
   await panelNotice(q,body.group,'🏆 '+g.rows[0].competition_name+' · EDIÇÃO '+number.rows[0].edition+'\n📣 INSCRIÇÕES ABERTAS · 0/'+body.size+' vagas\n\nEnvie !entrar para participar. Ao completar as vagas, o bot sorteia equipes e confrontos.');
   return {opened:true,edition:number.rows[0].edition};
  });
 }
 else if(body.action==='cup-cancel'||body.action==='cup-void'){
  const cancelling=body.action==='cup-cancel';
  const edition=Number(body.edition);
  if(!groupId.test(body.group)||!cancelling&&!templateId.test(body.cupId??'')&&(!Number.isSafeInteger(edition)||edition<1)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.reason))throw Error('Invalid cancellation');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);if(!g.rows.length)throw Error('Unauthorized group');
   let selectedId=body.cupId;
   if(!cancelling&&!templateId.test(selectedId??'')){
    const selected=await q.query("SELECT id FROM (SELECT id,row_number() OVER (ORDER BY created_at,id) AS edition FROM mlg_bot.cups WHERE group_id=$1 AND status<>'cancelled') history WHERE edition=$2",[body.group,edition]);
    selectedId=selected.rows[0]?.id;
   }
   const cup=await q.query(cancelling?"SELECT id,competition_name,status FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') FOR UPDATE": "SELECT id,competition_name,status FROM mlg_bot.cups WHERE group_id=$1 AND id=$2 FOR UPDATE",cancelling?[body.group]:[body.group,selectedId??null]);
   if(!cup.rows.length&&cancelling){
    const draft=await q.query('DELETE FROM mlg_bot.command_drafts WHERE group_id=$1 RETURNING group_id',[body.group]);
    if(!draft.rows.length)return {error:'Nenhuma Copa ativa neste grupo.'};
    await q.query('INSERT INTO mlg_bot.control_audit(action,group_id) VALUES($1,$2)',['panel-cancel-draft',body.group]);
    return {cancelled:true,draft:true};
   }
   if(!cup.rows.length||!cancelling&&cup.rows[0].status!=='completed')return {error:'Selecione uma edição encerrada para anular.'};
   const c=cup.rows[0],at=Date.now(),reason=body.reason.trim();
   const publicNumber=await q.query("SELECT edition FROM (SELECT id,row_number() OVER (ORDER BY created_at,id) AS edition FROM mlg_bot.cups WHERE group_id=$1 AND status<>'cancelled') history WHERE id=$2",[body.group,c.id]);
   await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[panelActor,'Painel MLG']);
   await q.query("UPDATE mlg_bot.cups SET status='cancelled',champion=NULL,completed_at=NULL,cancellation_reason=$2 WHERE id=$1",[c.id,reason]);
   await checkpointCup(q,body.group,c.id,panelActor,'panel-'+randomUUID());
   await q.query("INSERT INTO mlg_bot.audit_logs(actor,group_id,cup_id,occurred_at,action,before_state,after_state,outcome) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'accepted')",[panelActor,body.group,c.id,at,cancelling?'panel-cancel':'panel-void',JSON.stringify({status:c.status}),JSON.stringify({status:'cancelled',reason})]);
   await q.query('INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES($1,$2,$3)',[cancelling?'panel-cancel-cup':'panel-void-cup',body.group,panelActor]);
   await panelNotice(q,body.group,'🚫 '+c.competition_name+' · EDIÇÃO '+publicNumber.rows[0].edition+' CANCELADA\nMotivo: '+reason+'\n\nO número fica livre para a próxima Copa. O histórico segue guardado; jogos e títulos desta tentativa não contam nas estatísticas.');
   return {cancelled:true,edition:Number(publicNumber.rows[0].edition)};
  });
 }
 else if(body.action==='template-get'){
  if(!groupId.test(body.group)||!templateId.test(body.templateId??''))throw Error('Invalid template');
  result=await db.transaction(async q=>{
   const t=await q.query('SELECT t.id,t.name,t.team_kind AS "teamKind",t.teams FROM mlg_bot.competition_templates t JOIN mlg_bot.groups g ON g.id=t.group_id WHERE t.group_id=$1 AND t.id=$2 AND g.authorized',[body.group,body.templateId]);
   if(!t.rows.length)throw Error('Template unavailable');return {competition:t.rows[0]};
  });
 }
 else if(body.action==='template-save'){
  if(!groupId.test(body.group)||!validCompetition(body)||body.templateId!==null&&body.templateId!==undefined&&!templateId.test(body.templateId))throw Error('Invalid template');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);if(!g.rows.length)throw Error('Unauthorized group');
   const dup=await q.query('SELECT id FROM mlg_bot.competition_templates WHERE group_id=$1 AND lower(name)=lower($2) AND ($3::uuid IS NULL OR id<>$3::uuid)',[body.group,body.name.trim(),body.templateId??null]);
   if(dup.rows.length)return {error:'Já existe um modelo com esse nome neste grupo.'};
   let row;
   if(body.templateId){row=await q.query('UPDATE mlg_bot.competition_templates SET name=$3,team_kind=$4,teams=$5,updated_at=now() WHERE group_id=$1 AND id=$2 RETURNING id,name,team_kind AS "teamKind",teams',[body.group,body.templateId,body.name.trim(),body.teamKind,body.teams]);}
   else {row=await q.query('INSERT INTO mlg_bot.competition_templates(group_id,name,team_kind,teams) VALUES($1,$2,$3,$4) RETURNING id,name,team_kind AS "teamKind",teams',[body.group,body.name.trim(),body.teamKind,body.teams]);}
   if(!row.rows.length)return {error:'Modelo não encontrado neste grupo.'};
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('panel-save-template',$1)",[body.group]);return {saved:true,competition:row.rows[0]};
  });
 }
 else if(body.action==='template-activate'){
  if(!groupId.test(body.group)||!templateId.test(body.templateId??''))throw Error('Invalid template');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);if(!g.rows.length)throw Error('Unauthorized group');
   const active=await q.query("SELECT id FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') LIMIT 1",[body.group]);
   if(active.rows.length)return {error:'Termine ou cancele a Copa aberta antes de trocar o modelo ativo.'};
   const t=await q.query('SELECT id,name,team_kind AS "teamKind",teams FROM mlg_bot.competition_templates WHERE group_id=$1 AND id=$2',[body.group,body.templateId]);
   if(!t.rows.length)return {error:'Modelo não encontrado neste grupo.'};
   const chosen=t.rows[0];
   await q.query('UPDATE mlg_bot.groups SET competition_name=$2,team_kind=$3,format_size=NULL,active_template_id=$4 WHERE id=$1',[body.group,chosen.name,chosen.teamKind,chosen.id]);
   await q.query('DELETE FROM mlg_bot.club_pool WHERE group_id=$1',[body.group]);
   for(const team of chosen.teams)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[body.group,team]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('panel-activate-template',$1)",[body.group]);return {activated:true,competition:chosen};
  });
 }
 else if(body.action==='template-delete'){
  if(!groupId.test(body.group)||!templateId.test(body.templateId??''))throw Error('Invalid template');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT active_template_id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);if(!g.rows.length)throw Error('Unauthorized group');
   if(g.rows[0].active_template_id===body.templateId)return {error:'Modelo ativo: ative outro antes de excluir este.'};
   const deleted=await q.query('DELETE FROM mlg_bot.competition_templates WHERE group_id=$1 AND id=$2 RETURNING id',[body.group,body.templateId]);
   if(!deleted.rows.length)return {error:'Modelo não encontrado neste grupo.'};
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('panel-delete-template',$1)",[body.group]);return {deleted:true};
  });
 }
 else if(body.action==='admin-templates'){
  const e=body.event;if(!e||!groupId.test(e.group)||!validAliases(e.aliases)||typeof e.text!=='string'||e.text.length>90)throw Error('Invalid admin request');
  result=await db.transaction(async q=>{
   const id=await identity(q,e.aliases);
   const permission=await q.query("SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE g.authorized AND g.admins_configured AND a.role IN ('owner','admin') AND a.user_id=$1 LIMIT 1",[id]);
   if(!permission.rows.length)return {text:'🔒 Só os ADMs selecionados no painel podem trocar o campeonato.'};
   const g=await q.query('SELECT active_template_id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[e.group]);
   const rows=await q.query('SELECT id,name,team_kind,teams FROM mlg_bot.competition_templates WHERE group_id=$1 ORDER BY lower(name)',[e.group]);
   if(/^!modelos\s*$/i.test(e.text))return {text:'🏆 CAMPEONATOS DESTE GRUPO\n'+(rows.rows.map(t=>(t.id===g.rows[0].active_template_id?'● ':'○ ')+t.name+' · '+t.teams.length+' '+(t.team_kind==='seleção'?'seleções':t.team_kind==='misto'?'times':'clubes')).join('\n')||'Nenhum modelo salvo. Configure um no painel.')+'\n\nADM: !ativarmodelo Nome exato do campeonato. A Copa aberta não será alterada.'};
   const name=e.text.match(/^!ativarmodelo\s+(.+)$/i)?.[1]?.trim();
   if(!name)return {text:'⚙️ Use !modelos para ver as opções. Depois envie !ativarmodelo Nome exato do campeonato.'};
   const chosen=rows.rows.find(t=>t.name.toLocaleLowerCase('pt-BR')===name.toLocaleLowerCase('pt-BR'));
   if(!chosen)return {text:'⚠️ Campeonato não encontrado neste grupo. Consulte !modelos e use o nome completo.'};
   const active=await q.query("SELECT id FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') LIMIT 1",[e.group]);
   if(active.rows.length)return {text:'⚠️ Há uma Copa aberta. Termine ou cancele a edição antes de ativar outro modelo.'};
   await q.query('UPDATE mlg_bot.groups SET competition_name=$2,team_kind=$3,format_size=NULL,active_template_id=$4 WHERE id=$1',[e.group,chosen.name,chosen.team_kind,chosen.id]);
   await q.query('DELETE FROM mlg_bot.club_pool WHERE group_id=$1',[e.group]);
   for(const team of chosen.teams)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[e.group,team]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('whatsapp-activate-template',$1,$2)",[e.group,id]);
   return {text:'✅ '+chosen.name+' ativado! Agora um ADM pode usar !novacopa e escolher 4, 8, 16 ou 32 vagas.'};
  });
 }
 else if(body.action==='competition-save'){
  if(!groupId.test(body.group)||!validCompetition(body)||!(body.formatSize===null||[4,8,16,32].includes(body.formatSize))||body.teams.length<Math.max(4,body.formatSize??4))throw Error('Invalid competition');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group]);
   if(!g.rows.length)throw Error('Unauthorized group');
   const active=await q.query("SELECT id FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') LIMIT 1",[body.group]);
   if(active.rows.length)return {error:'Termine ou cancele a Copa em andamento antes de mudar seus times e regras.'};
   await q.query('UPDATE mlg_bot.groups SET competition_name=$2,team_kind=$3,format_size=$4 WHERE id=$1',[body.group,body.name.trim(),body.teamKind,body.formatSize]);
   await q.query('DELETE FROM mlg_bot.club_pool WHERE group_id=$1',[body.group]);
   for(const team of body.teams)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[body.group,team]);
   const existing=await q.query('SELECT id FROM mlg_bot.competition_templates WHERE group_id=$1 AND lower(name)=lower($2)',[body.group,body.name.trim()]);
   const template=existing.rows.length?await q.query('UPDATE mlg_bot.competition_templates SET name=$3,team_kind=$4,teams=$5,updated_at=now() WHERE group_id=$1 AND id=$2 RETURNING id',[body.group,existing.rows[0].id,body.name.trim(),body.teamKind,body.teams]):await q.query('INSERT INTO mlg_bot.competition_templates(group_id,name,team_kind,teams) VALUES($1,$2,$3,$4) RETURNING id',[body.group,body.name.trim(),body.teamKind,body.teams]);
   await q.query('UPDATE mlg_bot.groups SET active_template_id=$2 WHERE id=$1',[body.group,template.rows[0].id]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('panel-save-competition',$1)",[body.group]);
   return {updated:true,competition:{name:body.name.trim(),teamKind:body.teamKind,formatSize:body.formatSize,teams:body.teams}};
  });
 }
 else if(body.action==='getadmins'){
  if(!groupId.test(body.group))throw Error('Invalid group');
  result=await db.transaction(async q=>{
   const rev=await q.query("SELECT md5(coalesce(string_agg(user_id,',' ORDER BY user_id),'')) revision FROM mlg_bot.admins WHERE group_id=$1",[body.group]);
   const rows=await q.query('SELECT w.jid FROM mlg_bot.admins a JOIN mlg_bot.wa_identities w ON w.user_id=a.user_id JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.group_id=$1 AND g.admins_configured',[body.group]);
   return {aliases:rows.rows.map(r=>r.jid),revision:rev.rows[0].revision};
  });
 }
 else if(body.action==='setadmins'){
  if(!groupId.test(body.group)||!Array.isArray(body.admins)||body.admins.length<1||body.admins.length>10||!body.admins.every(validAliases))throw Error('Invalid admins');
  result=await db.transaction(async q=>{
   await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[body.group]);
   const rev=await q.query("SELECT md5(coalesce(string_agg(user_id,',' ORDER BY user_id),'')) revision FROM mlg_bot.admins WHERE group_id=$1",[body.group]);
   if(typeof body.revision!=='string'||body.revision!==rev.rows[0].revision)return {error:'A lista de ADMs mudou. Carregue os participantes novamente antes de salvar.'};
   await q.query('DELETE FROM mlg_bot.admins WHERE group_id=$1',[body.group]);
   for(const aliases of body.admins){const id=await identity(q,aliases);await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT DO NOTHING",[body.group,id]);}
   await q.query('UPDATE mlg_bot.groups SET admins_configured=true WHERE id=$1',[body.group]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('panel-replace-admins',$1)",[body.group]);return {updated:true};
  });
 }
 else if(body.action==='config'){
  const e=body.event;if(!e||!groupId.test(e.group)||!validAliases(e.aliases)||typeof e.text!=='string'||typeof e.id!=='string')throw Error('Invalid config');
  result=await db.transaction(async q=>{
   await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[e.group]);
   const id=await identity(q,e.aliases,e.name??'ADM');
   const adm=await q.query("SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND a.role IN ('owner','admin') AND g.admins_configured AND g.authorized LIMIT 1",[id]);
   if(!adm.rows.length)return {text:'🔒 Somente ADMs selecionados pelo dono no painel podem configurar.'};
   const claimed=await q.query('INSERT INTO mlg_bot.processed_messages VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id',[e.group,id,e.id,Date.now()]);
   if(!claimed.rows.length)return {text:null};
   await q.query('INSERT INTO mlg_bot.bot_settings(group_id) VALUES($1) ON CONFLICT DO NOTHING',[e.group]);
   const parts=e.text.trim().toLowerCase().split(/\s+/);
   if(parts.length===3&&['resenha','historico'].includes(parts[1])&&['ligar','desligar'].includes(parts[2])){
    const column=parts[1]==='resenha'?'resenha_enabled':'history_enabled';
    await q.query('UPDATE mlg_bot.bot_settings SET '+column+'=$2 WHERE group_id=$1',[e.group,parts[2]==='ligar']);
    await q.query('INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES($1,$2,$3)',['config-'+parts[1]+'-'+parts[2],e.group,id]);
   }else if(parts.length!==1)return {text:'⚙️ Use !config, !config resenha ligar/desligar ou !config historico ligar/desligar.'};
   const settings=await q.query('SELECT resenha_enabled,history_enabled FROM mlg_bot.bot_settings WHERE group_id=$1',[e.group]);
   const v=settings.rows[0];return {text:'⚙️ CONFIGURAÇÕES DO GRUPO\n😂 Resenha: '+(v.resenha_enabled?'ligada':'desligada')+'\n📚 Histórico aprovado: '+(v.history_enabled?'ligado':'desligado')+'\n!config resenha ligar/desligar\n!config historico ligar/desligar'};
  });
 }
 else if(body.action==='history-import'){
  if(!Array.isArray(body.entries)||body.entries.length>100)throw Error('Invalid import');
  result=await db.transaction(async q=>{for(const e of body.entries){
   if(!/^[a-f0-9]{64}$/.test(e.id)||typeof e.body!=='string'||e.body.length<20||e.body.length>500||typeof e.source!=='string'||typeof e.date!=='string')throw Error('Invalid entry');
   await q.query('INSERT INTO mlg_bot.history_entries(id,source,message_date,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[e.id,e.source.slice(0,60),e.date.slice(0,20),e.body]);
  }return {imported:body.entries.length};});
 }
 else if(body.action==='history-review'){
  if(!groupId.test(body.group)||typeof body.approved!=='boolean'||!Array.isArray(body.ids)||body.ids.length>20)throw Error('Invalid review');
  result=await db.transaction(async q=>{for(const id of body.ids)await q.query('INSERT INTO mlg_bot.history_reviews(group_id,entry_id,approved) VALUES($1,$2,$3) ON CONFLICT(group_id,entry_id) DO UPDATE SET approved=excluded.approved,reviewed_at=now()',[body.group,id,body.approved]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('panel-review-history',$1)",[body.group]);return {updated:true};});
 }
 else if(body.action==='history-candidates'){
  if(!groupId.test(body.group))throw Error('Invalid group');
  result=await db.transaction(async q=>{const filter=body.approved===true?'EXISTS(SELECT 1 FROM mlg_bot.history_reviews r WHERE r.entry_id=e.id AND r.group_id=$1 AND r.approved)':'NOT EXISTS(SELECT 1 FROM mlg_bot.history_reviews r WHERE r.entry_id=e.id AND r.group_id=$1)';
   const rows=await q.query('SELECT id,source,message_date,body FROM mlg_bot.history_entries e WHERE '+filter+' ORDER BY id LIMIT 10',[body.group]);return {entries:rows.rows};});
 }
 else if(body.action==='banter-context'){
  if(!groupId.test(body.group)||typeof body.query!=='string'||body.query.length>1000)throw Error('Invalid query');
  result=await db.transaction(async q=>{
   const g=await q.query('SELECT authorized FROM mlg_bot.groups WHERE id=$1',[body.group]);if(!g.rows[0]?.authorized)throw Error('Unauthorized group');
   const settings=await q.query('SELECT resenha_enabled,history_enabled FROM mlg_bot.bot_settings WHERE group_id=$1',[body.group]);const v=settings.rows[0]??{resenha_enabled:true,history_enabled:true};
   if(!v.resenha_enabled||!v.history_enabled)return {enabled:v.resenha_enabled,entries:[]};
   const rows=await q.query("SELECT e.id,e.source,e.message_date,e.body FROM mlg_bot.history_entries e JOIN mlg_bot.history_reviews r ON r.entry_id=e.id WHERE r.group_id=$1 AND r.approved AND e.search @@ plainto_tsquery('portuguese',$2) ORDER BY ts_rank(e.search,plainto_tsquery('portuguese',$2)) DESC,e.id LIMIT 3",[body.group,body.query]);
   return {enabled:true,entries:rows.rows};
  });
 }
 else if(body.action==='event'||body.action==='events'){
  const events=body.action==='events'?body.events:[body.event];if(!Array.isArray(events)||events.length<1||events.length>64)throw Error('Invalid batch');
  for(const e of events){
  if(!e||!groupId.test(e.group)||!validAliases(e.aliases)||typeof e.id!=='string'||e.id.length>150||!e.id||typeof e.text!=='string'||e.text.length>1000||typeof e.name!=='string')throw Error('Invalid event');
  result=await db.transaction(async q=>{
   const allowed=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized',[e.group]);if(!allowed.rows.length)throw Error('Group not authorized');
   const id=await identity(q,e.aliases,e.name);
   await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[e.group]);
   const season=await q.query("SELECT max(extract(epoch FROM at)*1000)::float8 AS started_at FROM mlg_bot.control_audit WHERE action='season-reset' AND NOT EXISTS (SELECT 1 FROM mlg_bot.loan_groups WHERE group_id=$1)",[e.group]);
   if(season.rows[0].started_at&&typeof e.at==='number'&&e.at<season.rows[0].started_at)return {accepted:false,obsolete:true};
   let eventText=e.text;
   if(/^!(?:contasverificadas|carreiraid|registrarid|associarid|cadastrarid|editarid|excluirid|statsid|tituloid|confrontoids)(?:\s|$)/i.test(eventText))throw Error('Invalid internal command');
   if(/^!(?:campeoes|campeões|historico|histórico)\s*$/i.test(eventText)){
    const loan=await q.query('SELECT 1 FROM mlg_bot.loan_groups WHERE group_id=$1',[e.group]);
    if(loan.rows.length){
     const blocked=await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[id]);
     if(blocked.rows.length)return {accepted:false,blocked:true};
     const inserted=await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id',[e.group,id,e.id,Date.now()]);
     if(!inserted.rows.length)return {accepted:true,duplicate:true};
     const saved=await q.query('SELECT edition,champion_name,competition_name FROM mlg_bot.loan_champions WHERE group_id=$1 ORDER BY edition DESC LIMIT 15',[e.group]);
     const current=await q.query(`SELECT c.competition_name,p.display_name FROM mlg_bot.cups c JOIN mlg_bot.cup_participants p ON p.cup_id=c.id AND p.user_id=c.champion
      WHERE c.group_id=$1 AND c.status='completed'`,[e.group]);
     const lines=saved.rows.map(r=>'🏆 Edição '+r.edition+' · '+r.competition_name+': '+r.champion_name);
     for(const row of current.rows)lines.unshift('🏆 Atual · '+row.competition_name+': '+row.display_name);
     const notice='🏆 CAMPEÕES DESTE GRUPO\n'+(lines.join('\n')||'Ainda não há campeão registrado.')+'\n\nCada campeonato encerrado conserva o campeão; partidas antigas são arquivadas.';
     await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[e.group,id,e.id,notice]);
     return {accepted:true};
    }
   }
   if(/^!sincronizarcontas\s*$/i.test(eventText)){
    const admin=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.group_id=$1 AND a.user_id=$2 AND g.admins_configured',[e.group,id]);
    if(admin.rows.length&&Array.isArray(e.targets)&&e.targets.length<=100&&e.targets.every(validAliases)){
     await q.query('SELECT pg_advisory_xact_lock(71012027)');let checked=0,linked=0,conflicts=0;
     for(const aliases of e.targets){
      const found=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[aliases]);
      if(found.rows.length>1){conflicts++;continue;}if(!found.rows.length)continue;
      const member=await q.query('SELECT 1 FROM mlg_bot.cup_participants p JOIN mlg_bot.cups c ON c.id=p.cup_id WHERE c.group_id=$1 AND p.user_id=$2 UNION SELECT 1 FROM mlg_bot.coach_profiles WHERE group_id=$1 AND user_id=$2',[e.group,found.rows[0].user_id]);
      if(!member.rows.length)continue;checked++;
      for(const alias of aliases){const inserted=await q.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING jid',[alias,found.rows[0].user_id]);linked+=inserted.rows.length;}
     }
     eventText=`!contasverificadas ${checked} ${linked} ${conflicts} ${e.targets.length}`;
    }
   }
   if(/^!(?:carreira|jornada|registrar|associar|cadastrar|editar|excluir|stats|titulo|título)\s/i.test(eventText)&&Array.isArray(e.targets)&&e.targets.length===1&&e.targets.every(validAliases)){
    const command=eventText.trim().split(/\s+/)[0].toLowerCase();
    if(['!cadastrar','!editar','!excluir','!registrar','!associar'].includes(command)){
     const admin=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.group_id=$1 AND a.user_id=$2 AND g.admins_configured',[e.group,id]);
     if(!admin.rows.length){eventText=command;}else{
      try{eventText=memberCommand(eventText,await identity(q,e.targets[0]));}catch{eventText=command;}
     }
    }else if(command==='!carreira'||command==='!jornada')eventText='!carreiraid '+await identity(q,e.targets[0]);
    else eventText=(command==='!stats'?'!statsid':'!tituloid')+' '+await identity(q,e.targets[0]);
   }
   if(/^!confronto\s/i.test(eventText)&&Array.isArray(e.targets)&&e.targets.length===2&&e.targets.every(validAliases)){
    const targets=[];for(const aliases of e.targets)targets.push(await identity(q,aliases));
    eventText='!confrontoids '+targets.join(' ');
   }
   const at=Number.isSafeInteger(e.at)&&e.at>1577836800000&&e.at<=Date.now()+60000?e.at:Date.now();
   const added=await q.query('INSERT INTO mlg_bot.inbox(group_id,user_id,message_id,display_name,body,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[e.group,id,e.id,e.name.slice(0,60),eventText,at]);
   if(added.rows.length){const rate=await q.query("INSERT INTO mlg_bot.command_rate VALUES($1,$2,now(),1) ON CONFLICT(group_id,user_id) DO UPDATE SET count=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN 1 ELSE command_rate.count+1 END,window_start=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN now() ELSE command_rate.window_start END RETURNING count",[e.group,id]);if(rate.rows[0].count>30)await q.query("UPDATE mlg_bot.inbox SET status='rejected',body='' WHERE id=$1",[added.rows[0].id]);}
   return {accepted:true};
  });
  }
  for(let i=0;i<Math.ceil(events.length/8);i++)await processInbox();
 }
 else if(body.action==='poll'){
  await processInbox();
  await autoConfirmDue(db);
  await archiveLoanCups();
  await guestAutoConfirm(db);
  await guestArchive(db);
  result=await db.transaction(async q=>{
   const rows=await q.query("SELECT id FROM mlg_bot.outbox WHERE (status='pending' AND available_at<=now()) OR (status='sending' AND lease_until<now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 3");
   const messages=[];
   for(const row of rows.rows){
    const lease=randomUUID();const r=await q.query("UPDATE mlg_bot.outbox SET status='sending',lease_until=now()+interval '90 seconds',delivery_token=$2,wa_message_id=coalesce(wa_message_id,$3),attempts=attempts+1 WHERE id=$1 RETURNING id,group_id,body,wa_message_id",[row.id,lease,randomUUID().replaceAll('-','').toUpperCase()]);
    const m=r.rows[0];let codes=[];
    const semis=m.body.match(/📣 SEMIFINALISTAS · jogos #(\d+) e #(\d+)/);
    const finalists=m.body.match(/🏆 FINALISTAS · jogo #(\d+)/);
    if(semis)codes=[semis[1],semis[2]];
    else if(finalists)codes=[finalists[1]];
    else if(m.body.startsWith('🎲 SORTEIO · '))codes=[...m.body.matchAll(/#(\d+)/g)].map(x=>x[1]);
    else if((m.body.startsWith('⚔️ ')||m.body.startsWith('🏆 FINAL · '))&&m.body.includes('🎮 JOGO '))codes=[...m.body.matchAll(/🎮 JOGO (\d+)/g)].map(x=>x[1]);
    else if(m.body.startsWith('✅ RESULTADO CONFIRMADO\n'))codes=[m.body.match(/^✅ RESULTADO CONFIRMADO\n#(\d+)/)?.[1]];
    codes=codes.filter(c=>c&&/^\d{1,15}$/.test(c));
    let mentions=[];
    if(codes.length&&codes.length<=16){
     const found=await q.query(`SELECT DISTINCT ON(w.user_id) w.jid FROM mlg_bot.matches game
      JOIN mlg_bot.cups cup ON cup.id=game.cup_id
      JOIN mlg_bot.wa_identities w ON w.user_id IN(game.home,game.away)
      WHERE cup.group_id=$1 AND game.code=ANY($2::bigint[]) AND w.jid LIKE '%@s.whatsapp.net'
      ORDER BY w.user_id,w.jid`,[m.group_id,codes]);
     mentions=found.rows.map(x=>x.jid).slice(0,32);
    }
    if(m.body.startsWith('🎲 CONFRONTOS · ')){
     const found=await q.query(`SELECT DISTINCT ON(w.user_id) w.jid FROM mlg_bot.guest_players p
      JOIN mlg_bot.guest_competitions c ON c.id=p.cup_id JOIN mlg_bot.wa_identities w ON w.user_id=p.user_id
      WHERE c.group_id=$1 AND c.status='playing' AND w.jid LIKE '%@s.whatsapp.net'
      ORDER BY w.user_id,w.jid LIMIT 32`,[m.group_id]);
     mentions=found.rows.map(x=>x.jid);
    }
    messages.push({...m,mentions,lease});
   }
   return {messages};
  });
 }
 else if(body.action==='ack'){
  if(!/^\d+$/.test(String(body.id))||typeof body.lease!=='string'||typeof body.sent!=='boolean')throw Error('Invalid acknowledgement');
  await db.transaction(q=>q.query("UPDATE mlg_bot.outbox SET status=CASE WHEN $3 THEN 'sent' ELSE 'pending' END,sent_at=CASE WHEN $3 THEN now() ELSE NULL END,available_at=now()+interval '30 seconds',lease_until=NULL WHERE id=$1 AND delivery_token=$2 AND status='sending'",[body.id,body.lease,body.sent]));result={ok:true};
 }
 else throw Error('Unsupported action');
 return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:'MINICAMP_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
});
