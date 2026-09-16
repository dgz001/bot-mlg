import makeWASocket,{DisconnectReason,jidNormalizedUser,extractMessageContent} from '@whiskeysockets/baileys';
import pino from 'pino';
import {createServer as httpServer} from 'node:http';
import {createServer} from 'node:net';
import {chmod,unlink} from 'node:fs/promises';
import {randomInt} from 'node:crypto';
import {vaultAuth} from './whatsapp/vault-auth.ts';
import {privateControl} from './infra/private-control.ts';
import {reconnect} from './infra/security.ts';
process.umask(0o077);
const endpoint=process.env.SESSION_VAULT_URL,token=process.env.SESSION_VAULT_TOKEN,master=process.env.AUTH_ENCRYPTION_KEY;
if(!endpoint||!token||!master||!process.env.CONTROL_PASSWORD||!process.env.CONTROL_ORIGIN)throw new Error('Resenha configuration missing');
const key=Buffer.from(master,/^[a-f0-9]{64}$/i.test(master)?'hex':'base64');
if(key.length!==32)throw new Error('Invalid session key');
const controlPath='/tmp/mlg-bot-control.sock';
const portal=privateControl({secret:process.env.CONTROL_PASSWORD,origin:process.env.CONTROL_ORIGIN,socketPath:controlPath,resenha:true});
for(const name of ['AUTH_ENCRYPTION_KEY','CONTROL_PASSWORD','SESSION_VAULT_TOKEN','DATABASE_URL','APP_DATABASE_PASSWORD'])delete process.env[name];
const log=(event:string)=>console.log(JSON.stringify({event,at:new Date().toISOString()}));
let phase='STARTING',stopping=false,attempt=0,timer:ReturnType<typeof setTimeout>|undefined,stable:ReturnType<typeof setTimeout>|undefined;
let auth:Awaited<ReturnType<typeof vaultAuth>>,socket:ReturnType<typeof makeWASocket>|undefined;
let queue=Promise.resolve();const cooldown=new Map<string,number>();
const phrases=['Hoje o VAR vai precisar de café. 😂','O controle descarrega antes das desculpas. 🎮','A coletiva depois do jogo promete mais que a partida. 🍿','Treino fechado ou ninguém achou o botão de marcar? 😂','Aqui até o gol contra pede replay. ⚽','Bola no chão, porque a desculpa já foi para a arquibancada. 😂','Quem pediu futebol? Hoje o cardápio é entretenimento. 🍿','O placar eu não invento. A resenha, essa vem pronta! 😂'];
async function connect(){
 if(stopping)return;phase='CONNECTING';
 const current=makeWASocket({auth:auth.state,logger:pino({level:'silent'}),syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false});socket=current;
 current.ev.on('creds.update',()=>{if(socket===current)void auth.save().catch(()=>fail('SESSION_SAVE_FAILED'));});
 current.ev.on('connection.update',u=>{
 if(socket!==current||stopping)return;
 if(u.connection==='open'){phase='CONNECTED';log(phase);stable=setTimeout(()=>{attempt=0;},60000);}
 if(u.connection==='close'){
 if(stable)clearTimeout(stable);socket=undefined;
 const status=(u.lastDisconnect?.error as {output?:{statusCode?:number}}|undefined)?.output?.statusCode;
 if(status===DisconnectReason.restartRequired){timer=setTimeout(()=>{void connect().catch(()=>fail('CONNECT_FAILED'));},1500);return;}
 const decision=reconnect(status===DisconnectReason.loggedOut?'logged-out':status===DisconnectReason.connectionReplaced?'connection-replaced':'transient',attempt++,Math.random());phase=decision.state;log(phase);
 if(decision.delayMs)timer=setTimeout(()=>{void connect().catch(()=>fail('CONNECT_FAILED'));},decision.delayMs);
 }
 });
 current.ev.on('messages.upsert',event=>{
 if(event.type!=='notify'||socket!==current)return;
 for(const message of event.messages){queue=queue.then(async()=>{
 const group=message.key.remoteJid,id=message.key.id;if(stopping||!group?.endsWith('@g.us')||!id||message.key.fromMe||!auth.data.groups.includes(group))return;
 const body=extractMessageContent(message.message);const text=body?.conversation??body?.extendedTextMessage?.text??'';const context=body?.extendedTextMessage?.contextInfo;
 const self=[current.user?.id,current.user?.lid].filter(Boolean).map(v=>jidNormalizedUser(v!));
 const mention=context?.mentionedJid?.some(j=>self.includes(jidNormalizedUser(j)));
 const reply=context?.participant&&self.includes(jidNormalizedUser(context.participant));
 if(text.trim().toLowerCase()!=='!resenha'&&!mention&&!reply)return;
 const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
 auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);
 if(Date.now()-(cooldown.get(group)??0)<60000)return;
 cooldown.set(group,Date.now());await auth.save();
 if(socket===current&&!stopping)await current.sendMessage(group,{text:phrases[randomInt(phrases.length)]!});
 }).catch(()=>fail('MESSAGE_PROCESSING_FAILED'));}
 });
}
const controls=createServer(client=>{let buffer='';client.setTimeout(45000,()=>client.destroy());client.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>8192){client.destroy();return;}if(!buffer.includes('\n'))return;client.pause();void(async()=>{
 const req=JSON.parse(buffer.trim());if(req.action==='status')return {phase};
 if(req.action==='pair'){
 if(auth.state.creds.registered||phase==='CONNECTED'||phase==='STOPPED')throw new Error('Pairing unavailable');
 if(!/^\d{10,15}$/.test(req.phone??''))throw new Error('Invalid phone');
 if(timer)clearTimeout(timer);if(!socket)await connect();await new Promise(r=>setTimeout(r,1500));return {code:await socket!.requestPairingCode(req.phone)};
 }
 if(phase!=='CONNECTED'||!socket)throw new Error('Not connected');
 if(req.action==='groups')return {groups:Object.values(await socket.groupFetchAllParticipating()).map(g=>({id:g.id,name:g.subject}))};
 if(typeof req.group!=='string'||!req.group.endsWith('@g.us'))throw new Error('Invalid group');
 const group=await socket.groupMetadata(req.group);
 if(req.action==='participants')return {participants:group.participants.map(p=>({id:p.id,phone:p.id}))};
 if(req.action==='authorize'){
 if(!group.participants.some(p=>p.id===req.admin))throw new Error('Invalid participant');
 if(!auth.data.groups.includes(req.group))auth.data.groups.push(req.group);await auth.save();log('GROUP_AUTHORIZED');return {authorized:true};
 }throw new Error('Unknown operation');
 })().then(r=>client.end(JSON.stringify(r)+'\n')).catch(()=>client.end(JSON.stringify({error:'Operação recusada. Confira conexão, número e seleção.'})+'\n'));});});
const health=httpServer((req,res)=>{if(req.url==='/livez'||req.url==='/readyz'){const ok=!stopping&&(req.url==='/livez'||phase==='CONNECTED');res.writeHead(ok?200:503,{'Cache-Control':'no-store'}).end(ok?'OK':'UNAVAILABLE');return;}void portal(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
function fail(event:string){log(event);void shutdown(1);}
async function shutdown(code:number){if(stopping)return;stopping=true;if(timer)clearTimeout(timer);if(stable)clearTimeout(stable);const deadline=setTimeout(()=>process.exit(code),12000);deadline.unref();controls.close();health.close();socket?.end(undefined);await queue;await auth?.flush();key.fill(0);process.exit(code);}
process.on('SIGTERM',()=>{void shutdown(0);});process.on('SIGINT',()=>{void shutdown(0);});process.on('uncaughtException',()=>fail('UNCAUGHT_ERROR'));process.on('unhandledRejection',()=>fail('UNHANDLED_REJECTION'));
async function main(){auth=await vaultAuth(endpoint!,token!,key);await auth.save();await unlink(controlPath).catch(()=>undefined);controls.listen(controlPath,()=>{void chmod(controlPath,0o600).catch(()=>fail('CONTROL_PERMISSIONS_FAILED'));});health.listen(Number(process.env.PORT??3000),'0.0.0.0');if(auth.state.creds.registered)await connect();else {phase='NEEDS_PAIRING';log(phase);}}
void main().catch(()=>fail('SESSION_STORAGE_UNAVAILABLE'));
