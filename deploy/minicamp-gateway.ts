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
  if(!groupId.test(body.group)||!Array.isArray(body.admins)||body.admins.length<1||body.admins.length>100||!body.admins.every(validAliases)||!Array.isArray(body.clubs)||body.clubs.length<16||body.clubs.length>100||body.clubs.some(c=>typeof c!=='string'||c.length<2||c.length>60)||new Set(body.clubs).size!==body.clubs.length)throw Error('Invalid configuration');
  result=await db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(71012027)');
   const inserted=await q.query('INSERT INTO mlg_bot.groups(id,authorized) VALUES($1,true) ON CONFLICT DO NOTHING RETURNING id',[body.group]);
   if(!inserted.rows.length)return {configured:true,existing:true};
   for(const aliases of body.admins){const id=await identity(q,aliases);await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[body.group,id]);}
   for(const club of body.clubs)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[body.group,club]);
   await q.query("INSERT INTO mlg_bot.control_audit(action,group_id) VALUES('bootstrap-verified-whatsapp-admins',$1)",[body.group]);
   return {configured:true};
  });
 }
 else if(body.action==='event'||body.action==='events'){
  const events=body.action==='events'?body.events:[body.event];if(!Array.isArray(events)||events.length<1||events.length>64)throw Error('Invalid batch');
  for(const e of events){
  if(!e||!groupId.test(e.group)||!validAliases(e.aliases)||typeof e.id!=='string'||e.id.length>150||!e.id||typeof e.text!=='string'||e.text.length>1000||typeof e.name!=='string')throw Error('Invalid event');
  result=await db.transaction(async q=>{
   const allowed=await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized',[e.group]);if(!allowed.rows.length)throw Error('Group not authorized');
   const id=await identity(q,e.aliases,e.name);
   const added=await q.query('INSERT INTO mlg_bot.inbox(group_id,user_id,message_id,display_name,body,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[e.group,id,e.id,e.name.slice(0,60),e.text,Date.now()]);
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
