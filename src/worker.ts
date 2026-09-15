import makeWASocket, { DisconnectReason, jidNormalizedUser, extractMessageContent } from '@whiskeysockets/baileys';
import { Pool, type PoolClient } from 'pg';
import pino from 'pino';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import { authStore } from './whatsapp/auth-store.ts';
import { processEvent, pgDatabase } from './infra/postgres.ts';
import { reconnect } from './infra/security.ts';
import { privateControl } from './infra/private-control.ts';

process.umask(0o077);
const account='secondary';
const controlPath='/tmp/mlg-bot-control.sock';
const database=process.env.DATABASE_URL, appPassword=process.env.APP_DATABASE_PASSWORD, master=process.env.AUTH_ENCRYPTION_KEY;
if(!database || !appPassword || !master) throw new Error('Worker configuration missing');
const url=new URL(database);
// Supabase session pooler routes by the project suffix in the login name.
const tenant=url.hostname.endsWith('.pooler.supabase.com') ? decodeURIComponent(url.username).split('.').slice(1).join('.') : '';
url.username=tenant ? `mlg_bot_app.${tenant}` : 'mlg_bot_app';url.password=appPassword;
delete process.env.DATABASE_URL;delete process.env.APP_DATABASE_PASSWORD;delete process.env.AUTH_ENCRYPTION_KEY;
const key=Buffer.from(master,/^[a-f0-9]{64}$/i.test(master)?'hex':'base64');
if(key.length!==32) throw new Error('Invalid encryption key length');
const pool=new Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:10000,statement_timeout:15000});
const log=(event:string)=>console.log(JSON.stringify({event,at:new Date().toISOString()}));
let stopping=false,phase='STARTING',lastTick=Date.now(),busy=false,attempt=0;
let socket:ReturnType<typeof makeWASocket>|undefined;
let retry:ReturnType<typeof setTimeout>|undefined;
let stable:ReturnType<typeof setTimeout>|undefined;
let auth:Awaited<ReturnType<typeof authStore>>;
let leader:PoolClient;
function fail(event:string) { log(event);void shutdown(1); }
pool.on('error',()=>fail('DATABASE_CONNECTION_LOST'));
process.on('uncaughtException',()=>fail('UNCAUGHT_ERROR'));
process.on('unhandledRejection',()=>fail('UNHANDLED_REJECTION'));

async function identity(jid:string):Promise<string> {
  const normalized=jidNormalizedUser(jid);
  if(!/^[0-9]+@(lid|s\.whatsapp\.net)$/.test(normalized)) throw new Error('Unsupported identity');
  const aliases=[normalized];
  const mappings=socket?.signalRepository.lidMapping;
  const linked=normalized.endsWith('@lid')?await mappings?.getPNForLID(normalized):await mappings?.getLIDForPN(normalized);
  if(linked) aliases.push(jidNormalizedUser(linked));
  const q=await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query('SELECT pg_advisory_xact_lock(71012027)');
    const existing=await q.query('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[aliases]);
    if(existing.rows.length>1) throw new Error('Identity conflict requires administrator review');
    const id=existing.rows[0]?.user_id ?? randomUUID();
    await q.query("INSERT INTO mlg_bot.users VALUES($1,'Participante') ON CONFLICT DO NOTHING",[id]);
    for(const alias of aliases) await q.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2) ON CONFLICT(jid) DO NOTHING',[alias,id]);
    await q.query('COMMIT'); return id;
  } catch(error){await q.query('ROLLBACK').catch(()=>undefined);throw error;} finally {q.release();}
}

async function connect() {
  if(stopping) return;
  phase='CONNECTING';
  auth=await authStore(pool,account,key);
  const currentAuth=auth;
  const current=makeWASocket({auth:currentAuth.state,logger:pino({level:'silent'}),syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false});
  socket=current;
  current.ev.on('creds.update',()=>{if(current!==socket)return;void currentAuth.save().catch(()=>fail('AUTH_SAVE_FAILED'));});
  current.ev.on('connection.update',u=>{
    if(current!==socket || stopping)return;
    if(u.connection==='open') {
      phase='CONNECTED';log('CONNECTED');
      stable=setTimeout(()=>{attempt=0;},60000);
    }
    if(u.connection==='close') {
      if(stable)clearTimeout(stable);
      const code=(u.lastDisconnect?.error as {output?:{statusCode?:number}})?.output?.statusCode;
      const decision=reconnect(code===DisconnectReason.loggedOut?'logged-out':code===DisconnectReason.connectionReplaced?'connection-replaced':'transient',attempt++,Math.random());
      phase=decision.state;log(phase);
      if(decision.delayMs)retry=setTimeout(()=>{void connect().catch(()=>fail('RECONNECT_FAILED'));},decision.delayMs);
    }
    // QR fields are intentionally ignored; never logged or sent over HTTP.
  });
  current.ev.on('messages.upsert',event=>{
    if(event.type!=='notify')return;
    void (async()=>{
      for(const m of event.messages) {
        const group=m.key.remoteJid;
        if(!group?.endsWith('@g.us') || m.key.fromMe || !m.key.id || !m.key.participant)continue;
        const content=extractMessageContent(m.message);
        let text=content?.conversation ?? content?.extendedTextMessage?.text ?? '';
        if(!text || text.length>1000 || (!text.startsWith('!') && !/^[123]$/.test(text)))continue;
        const allowed=await pool.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized',[group]);
        if(!allowed.rowCount)continue;
        text=text.replace(/^!bot adm copa cancelar\b/i,'!cancelar').replace(/^!bot adm resultado resolver\b/i,'!resolver');
        const user=await identity(m.key.participant);
        const q=await pool.connect();
        try {
          await q.query('BEGIN');
          const added=await q.query(`INSERT INTO mlg_bot.inbox(group_id,user_id,message_id,display_name,body,received_at)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[group,user,m.key.id,(m.pushName ?? 'Participante').slice(0,60),text,Date.now()]);
          if(added.rowCount) {
            const rate=await q.query(`INSERT INTO mlg_bot.command_rate VALUES($1,$2,now(),1)
              ON CONFLICT(group_id,user_id) DO UPDATE SET count=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN 1 ELSE command_rate.count+1 END,
              window_start=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN now() ELSE command_rate.window_start END RETURNING count`,[group,user]);
            if(rate.rows[0].count>20)await q.query("UPDATE mlg_bot.inbox SET status='rejected',body='' WHERE id=$1",[added.rows[0].id]);
          }
          await q.query('COMMIT');
        }catch(error){await q.query('ROLLBACK').catch(()=>undefined);throw error;}finally{q.release();}
      }
    })().catch(()=>fail('INBOX_PERSIST_FAILED'));
  });
}

async function finishSpecial(row:Record<string,any>,body:string) {
  await pgDatabase(pool).transaction(async q=>{
    const added=await q.query(`INSERT INTO mlg_bot.processed_messages VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id`,[row.group_id,row.user_id,row.message_id,Number(row.received_at)]);
    if(added.rows.length && body)await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[row.group_id,row.user_id,row.message_id,body]);
    await q.query("UPDATE mlg_bot.inbox SET status='done',body='' WHERE id=$1",[row.id]);
  });
}

async function tick() {
  if(busy || stopping)return;busy=true;
  try {
    await leader.query('SELECT 1');
    lastTick=Date.now();
    const rows=await pool.query("SELECT * FROM mlg_bot.inbox WHERE status='pending' ORDER BY id LIMIT 10");
    for(const row of rows.rows) {
      const special=/^!bot adm (status|resenha (leve|normal|pesada))$/i.exec(row.body);
      if(special) {
        const admin=await pool.query('SELECT 1 FROM mlg_bot.admins WHERE group_id=$1 AND user_id=$2',[row.group_id,row.user_id]);
        if(!admin.rowCount){await finishSpecial(row,'Somente ADM autorizado.');continue;}
        if(special[2]) {
          await pool.query('INSERT INTO mlg_bot.bot_settings(group_id,banter_level) VALUES($1,$2) ON CONFLICT(group_id) DO UPDATE SET banter_level=excluded.banter_level',[row.group_id,special[2].toUpperCase()]);
          await pool.query('INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES($1,$2,$3)',['banter-level',row.group_id,row.user_id]);
        }
        await finishSpecial(row,special[2]?`Resenha: ${special[2].toUpperCase()}`:`Bot: ${phase}`);continue;
      }
      if(row.body.toLowerCase()==='!resenha') {
        const recent=await pool.query("SELECT 1 FROM mlg_bot.outbox WHERE group_id=$1 AND body LIKE '😂%' AND available_at>now()-interval '1 minute'",[row.group_id]);
        const phrases=['Hoje o VAR vai precisar de café. 😂','Aqui o controle descarrega antes das desculpas. 🎮','A coletiva depois da derrota promete mais que o jogo. 🍿','Treino fechado? Ou ninguém achou o botão de marcar? 😂'];
        await finishSpecial(row,recent.rowCount?'':`😂 ${phrases[randomInt(phrases.length)]}`);continue;
      }
      try {
        await processEvent(pgDatabase(pool),{id:row.message_id,groupId:row.group_id,userId:row.user_id,name:row.display_name,text:row.body,at:Number(row.received_at)});
        await pool.query("UPDATE mlg_bot.inbox SET status='done',body='' WHERE id=$1",[row.id]);
      } catch(error) {
        if((error as {code?:string}).code)throw error;
        // Domain errors never contain transport/session objects. Avoid exposing
        // unknown exception text even when it has no SQLSTATE.
        const msg=error instanceof Error?error.message:'';
        const safe=/^(Somente|Não |Nenhum|Nenhuma|Já |Você |Grupo |Partida |Resultado |Copa |Mata-mata|Formato:|Informe|Código |Inscrições|Escolha |Comando desconhecido)/.test(msg)?msg:'Comando não aceito. Confira os dados e tente novamente.';
        await finishSpecial(row,safe);
      }
    }
    if(phase==='CONNECTED' && socket) {
      const pending=await pool.query("SELECT * FROM mlg_bot.outbox WHERE status='pending' AND available_at<=now() ORDER BY id LIMIT 3");
      for(const row of pending.rows) {
        // Stable ID survives a crash between send and acknowledgment. WhatsApp
        // can still redeliver; business transitions are separately idempotent.
        const id=row.wa_message_id ?? randomUUID().replaceAll('-','').toUpperCase();
        await pool.query('UPDATE mlg_bot.outbox SET wa_message_id=$1,attempts=attempts+1 WHERE id=$2',[id,row.id]);
        try {
          await socket.sendMessage(row.group_id,{text:row.body},{messageId:id});
          await pool.query("UPDATE mlg_bot.outbox SET status='sent',sent_at=now() WHERE id=$1",[row.id]);
        } catch {
          await pool.query("UPDATE mlg_bot.outbox SET available_at=now()+interval '30 seconds',status=CASE WHEN attempts>=10 THEN 'failed' ELSE 'pending' END WHERE id=$1",[row.id]);
          log('OUTBOX_RETRY'); break;
        }
      }
    }
  } catch {fail('SCHEDULER_DATABASE_ERROR');} finally{busy=false;}
}

const controls=createServer(client=>{
  let buffer='';client.setTimeout(45000,()=>client.destroy());
  client.on('data',chunk=>{
    buffer+=chunk.toString();if(buffer.length>8192){client.destroy();return;}
    if(!buffer.includes('\n'))return;
    client.pause();
    void (async()=>{
      const req=JSON.parse(buffer.trim());
      if(req.action==='status')return {phase};
      if(req.action==='pair') {
        if(auth.state.creds.registered || phase==='CONNECTED')throw new Error('Already paired');
        if(!/^\d{10,15}$/.test(req.phone ?? ''))throw new Error('Invalid phone');
        if(!socket || phase==='NEEDS_PAIRING')await connect();
        await new Promise(resolve=>setTimeout(resolve,1500));
        const code=await socket!.requestPairingCode(req.phone);
        return {code};
      }
      if(req.action==='reset-session') {
        if(req.confirm!=='RESET')throw new Error('Explicit reset confirmation required');
        if(retry)clearTimeout(retry);if(stable)clearTimeout(stable);
        const old=socket;socket=undefined;old?.end(undefined);
        await auth.flush();
        await pool.query('DELETE FROM mlg_bot.wa_auth WHERE account_id=$1',[account]);
        auth=await authStore(pool,account,key);phase='NEEDS_PAIRING';
        await pool.query("INSERT INTO mlg_bot.control_audit(action) VALUES('reset-session')");return {phase};
      }
      if(phase!=='CONNECTED' || !socket)throw new Error('WhatsApp not connected');
      if(req.action==='groups')return {groups:Object.values(await socket.groupFetchAllParticipating()).map(g=>({id:g.id,name:g.subject}))};
      if(typeof req.group!=='string' || !req.group.endsWith('@g.us'))throw new Error('Invalid group');
      const group=await socket.groupMetadata(req.group);
      if(req.action==='participants')return {participants:await Promise.all(group.participants.map(async p=>({id:p.id,phone:p.id.endsWith('@lid')?await socket!.signalRepository.lidMapping.getPNForLID(p.id):p.id})))};
      if(req.action==='authorize') {
        if(!group.participants.some(p=>p.id===req.admin))throw new Error('Admin must be verified group participant');
        if(!Array.isArray(req.clubs) || req.clubs.length<16 || req.clubs.length>100 || new Set(req.clubs).size!==req.clubs.length || req.clubs.some((c:unknown)=>typeof c!=='string' || c.length>60 || c.length<2))throw new Error('Supply 16-100 unique club names');
        const user=await identity(req.admin);
        await pgDatabase(pool).transaction(async q=>{
          await q.query('INSERT INTO mlg_bot.groups VALUES($1,true) ON CONFLICT(id) DO UPDATE SET authorized=true',[req.group]);
          await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[req.group,user]);
          for(const club of req.clubs)await q.query('INSERT INTO mlg_bot.club_pool VALUES($1,$2) ON CONFLICT DO NOTHING',[req.group,club.trim()]);
          await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('authorize', $1,$2)",[req.group,user]);
        });return {authorized:true};
      }
      throw new Error('Unsupported control command');
    })().then(result=>client.end(JSON.stringify(result)+'\n')).catch(()=>client.end(JSON.stringify({error:'Operação recusada. Confira conexão, seleção e formato.'})+'\n'));
  });
});
const portal=process.env.CONTROL_PASSWORD && process.env.CONTROL_ORIGIN ? privateControl({secret:process.env.CONTROL_PASSWORD,origin:process.env.CONTROL_ORIGIN,socketPath:controlPath}) : undefined;
delete process.env.CONTROL_PASSWORD;
const health=httpServer((req,res)=>{
  if(req.url!=='/livez' && req.url!=='/readyz'){
    if(portal)void portal(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});else res.writeHead(404).end();return;
  }
  const ok=!stopping && Date.now()-lastTick<45000 && (req.url==='/livez' || phase==='CONNECTED');
  res.writeHead(ok?200:503,{'Content-Type':'text/plain','Cache-Control':'no-store'}).end(ok?'OK':'UNAVAILABLE');
});
let timer:ReturnType<typeof setInterval>|undefined;
async function shutdown(code:number) {
  if(stopping)return;stopping=true;if(timer)clearInterval(timer);if(retry)clearTimeout(retry);if(stable)clearTimeout(stable);
  const deadline=setTimeout(()=>process.exit(code),12000);deadline.unref();
  controls.close();health.close();socket?.end(undefined);
  while(busy)await new Promise(r=>setTimeout(r,50));
  await auth?.flush();leader?.release();await pool.end();key.fill(0);process.exit(code);
}
process.on('SIGTERM',()=>{void shutdown(0);});process.on('SIGINT',()=>{void shutdown(0);});
async function main() {
  leader=await pool.connect();leader.on('error',()=>fail('LEADER_CONNECTION_LOST'));
  const lock=await leader.query('SELECT pg_try_advisory_lock(71012028) AS acquired');
  if(!lock.rows[0].acquired)throw new Error('Another worker owns this account');
  auth=await authStore(pool,account,key);
  await unlink(controlPath).catch(()=>undefined);
  controls.listen(controlPath,()=>{void chmod(controlPath,0o600).catch(()=>fail('CONTROL_PERMISSIONS_FAILED'));});
  health.listen(Number(process.env.PORT ?? 3000),'0.0.0.0');
  timer=setInterval(()=>{void tick();},1000);
  if(auth.state.creds.registered)await connect();else{phase='NEEDS_PAIRING';log(phase);}
}
void main().catch(()=>fail('WORKER_START_FAILED'));
