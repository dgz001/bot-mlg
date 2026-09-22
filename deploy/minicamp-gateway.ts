import {minicampClubs} from './clubs.ts';
// Private server-to-server gateway. Inject only a token digest during deployment.
import {Pool} from 'npm:pg@8.23.0';
import {randomUUID} from 'node:crypto';
import {pgDatabase,processEvent} from './postgres.ts';
const EXPECTED_DIGEST='__DIGEST__';
const pool=new Pool({connectionString:Deno.env.get('SUPABASE_DB_URL'),max:2,connectionTimeoutMillis:8000});
const base=pgDatabase(pool);
const db={transaction:run=>base.transaction(async q=>{await q.query('SET LOCAL ROLE mlg_bot_gateway');return run(q);})};
const jid=/^[0-9]+@(lid|s\.whatsapp\.net)$/;
const groupId=/^[0-9-]+@g\.us$/;
function validAliases(v){return Array.isArray(v)&&v.length>=1&&v.length<=2&&v.every(x=>typeof x==='string'&&jid.test(x));}
async function identity(q,aliases,name='Participante'){
 if(!validAliases(aliases))throw Error('Invalid identity');
 await q.query('SELECT pg_advisory_xact_lock(71012027)');
 const existing=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[aliases]);
 if(existing.rows.length>1)throw Error('Identity conflict');
 const id=existing.rows[0]?.user_id??randomUUID();
 await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name',[id,name.slice(0,60)]);
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
   const adm=await q.query('SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id WHERE g.id=$1 AND a.user_id=$2 AND g.admins_configured AND g.authorized',[e.group,id]);
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
