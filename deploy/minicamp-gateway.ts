import {minicampClubs} from './clubs.ts';
// Private server-to-server gateway. Inject only a token digest during deployment.
import {Pool} from 'npm:pg@8.23.0';
import {randomUUID} from 'node:crypto';
import {pgDatabase,processEvent,checkpointCup,cupDraw,cupRoster,cupRerollTeam} from './postgres.ts';
import {memberCommand} from './member-commands.ts';
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
Deno.serve(async req=>{
 const header=req.headers.get('authorization')??'';
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(header)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(digest!==EXPECTED_DIGEST)return new Response('Unauthorized',{status:401});
 if(req.method!=='POST')return new Response('Method not allowed',{status:405});
 try{
 const raw=await req.text();if(raw.length>32000)return new Response('Too large',{status:413});
 const body=JSON.parse(raw);let result={};
 if(body.action==='health'){await db.transaction(q=>q.query('SELECT 1'));result={database:true};}
 else if(body.action==='control-check'){
  if(!groupId.test(body.group)||!validAliases(body.aliases))throw Error('Invalid control identity');
  result=await db.transaction(async q=>{
   const id=await identity(q,body.aliases);
   const allowed=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND g.authorized AND g.admins_configured AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks b WHERE b.user_id=a.user_id) LIMIT 1',[id]);
   return {allowed:allowed.rows.length===1};
  });
 }
 else if(body.action==='block-check'){
  if(!validAliases(body.aliases))throw Error('Invalid member identity');
  result=await db.transaction(async q=>{
   const match=await q.query('SELECT 1 FROM mlg_bot.member_blocks b JOIN mlg_bot.wa_identities w ON w.user_id=b.user_id WHERE w.jid=ANY($1::text[]) LIMIT 1',[body.aliases]);
   return {blocked:match.rows.length>0};
  });
 }
 else if(body.action==='member-block'){
  if(!groupId.test(body.group)||!validAliases(body.aliases)||body.operation!=='list'&&body.operation!=='block'&&body.operation!=='unblock'||body.operation!=='list'&&(!validAliases(body.targetAliases)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(body.reason)))throw Error('Invalid block request');
  result=await db.transaction(async q=>{
   const actor=await identity(q,body.aliases);
   const permission=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND g.authorized AND g.admins_configured AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks b WHERE b.user_id=a.user_id) LIMIT 1',[actor]);
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
   const nextEdition=await q.query("SELECT count(*)::int+1 AS edition FROM mlg_bot.cups WHERE group_id=$1 AND status<>'cancelled'",[body.group]);
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
   const number=await q.query("SELECT count(*)::int+1 AS edition FROM mlg_bot.cups WHERE group_id=$1 AND status<>'cancelled'",[body.group]);
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
   const permission=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE g.authorized AND g.admins_configured AND a.user_id=$1 LIMIT 1',[id]);
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
   const adm=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE a.user_id=$1 AND g.admins_configured AND g.authorized LIMIT 1',[id]);
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
   let eventText=e.text;
   if(/^!(?:contasverificadas|carreiraid|registrarid|associarid|cadastrarid|editarid|excluirid|statsid|tituloid|confrontoids)(?:\s|$)/i.test(eventText))throw Error('Invalid internal command');
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
   const added=await q.query('INSERT INTO mlg_bot.inbox(group_id,user_id,message_id,display_name,body,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[e.group,id,e.id,e.name.slice(0,60),eventText,Date.now()]);
   if(added.rows.length){const rate=await q.query("INSERT INTO mlg_bot.command_rate VALUES($1,$2,now(),1) ON CONFLICT(group_id,user_id) DO UPDATE SET count=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN 1 ELSE command_rate.count+1 END,window_start=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN now() ELSE command_rate.window_start END RETURNING count",[e.group,id]);if(rate.rows[0].count>30)await q.query("UPDATE mlg_bot.inbox SET status='rejected',body='' WHERE id=$1",[added.rows[0].id]);}
   return {accepted:true};
  });
  }
  for(let i=0;i<Math.ceil(events.length/8);i++)await processInbox();
 }
 else if(body.action==='poll'){
  await processInbox();
  result=await db.transaction(async q=>{
   const rows=await q.query("SELECT id FROM mlg_bot.outbox WHERE (status='pending' AND available_at<=now()) OR (status='sending' AND lease_until<now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 3");
   const messages=[];
   for(const row of rows.rows){const lease=randomUUID();const r=await q.query("UPDATE mlg_bot.outbox SET status='sending',lease_until=now()+interval '90 seconds',delivery_token=$2,wa_message_id=coalesce(wa_message_id,$3),attempts=attempts+1 WHERE id=$1 RETURNING id,group_id,body,wa_message_id",[row.id,lease,randomUUID().replaceAll('-','').toUpperCase()]);messages.push({...r.rows[0],lease});}
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
