import {minicampClubs} from './minicamp/clubs.ts';
import {moduleEnabled,parseControls} from './infra/bot-controls.ts';
import {allowsGroup,groupMode,validGroupMode} from './infra/group-modes.ts';
import {minicampClient,minicampCommand,type PendingCupEvent} from './minicamp/client.ts';
import {loadRoster} from './resenha/matchup.ts';
import makeWASocket,{DisconnectReason,jidNormalizedUser,extractMessageContent} from '@whiskeysockets/baileys';
import pino from 'pino';
import {banterRequest} from './resenha/trigger.ts';
import {requestReadyPairing} from './whatsapp/pairing.ts';
import {createServer as httpServer} from 'node:http';
import {createServer} from 'node:net';
import {chmod,unlink} from 'node:fs/promises';
import {createBanterReply} from './resenha/reply.ts';
import {vaultAuth} from './whatsapp/vault-auth.ts';
import {privateControl} from './infra/private-control.ts';
import {reconnect} from './infra/security.ts';
process.umask(0o077);
const endpoint=process.env.SESSION_VAULT_URL,token=process.env.SESSION_VAULT_TOKEN,master=process.env.AUTH_ENCRYPTION_KEY;
if(!endpoint||!token||!master||!process.env.CONTROL_PASSWORD||!process.env.CONTROL_ORIGIN)throw new Error('Resenha configuration missing');
const key=Buffer.from(master,/^[a-f0-9]{64}$/i.test(master)?'hex':'base64');
if(key.length!==32)throw new Error('Invalid session key');
const cupApi=process.env.MINICAMP_URL&&process.env.MINICAMP_TOKEN?minicampClient(process.env.MINICAMP_URL,process.env.MINICAMP_TOKEN):undefined;
delete process.env.MINICAMP_TOKEN;
const cupClubs=[...minicampClubs];
const configuredCups=new Set<string>();
let cupBusy=false,lastCupTick=Date.now(),lastCupSuccessAt=0,cupHealthy=!cupApi,cupTimer:ReturnType<typeof setInterval>|undefined;
const controlPath='/tmp/mlg-bot-control.sock';
const portal=privateControl({secret:process.env.CONTROL_PASSWORD,origin:process.env.CONTROL_ORIGIN,socketPath:controlPath,resenha:true});
for(const name of ['AUTH_ENCRYPTION_KEY','CONTROL_PASSWORD','SESSION_VAULT_TOKEN','DATABASE_URL','APP_DATABASE_PASSWORD'])delete process.env[name];
const log=(event:string)=>console.log(JSON.stringify({event,at:new Date().toISOString()}));
let phase='STARTING',stopping=false,attempt=0,timer:ReturnType<typeof setTimeout>|undefined,stable:ReturnType<typeof setTimeout>|undefined;
let auth:Awaited<ReturnType<typeof vaultAuth>>,socket:ReturnType<typeof makeWASocket>|undefined;
const pairingReady=new WeakSet<object>();
let queue=Promise.resolve();
let banterReply:ReturnType<typeof createBanterReply>;
const enabled=(module?:'resenha'|'minicamp')=>moduleEnabled(auth.data.controls,module);
const inChannel=(group:string,module:'resenha'|'minicamp')=>auth.data.groups.includes(group)&&allowsGroup(auth.data.groupModes,group,module);
async function connect(){
 if(stopping)return;phase='CONNECTING';
 const current=makeWASocket({auth:auth.state,logger:pino({level:'silent'}),syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false});socket=current;
 current.ev.on('creds.update',()=>{if(socket===current)void auth.save().catch(()=>fail('SESSION_SAVE_FAILED'));});
 current.ev.on('connection.update',u=>{
 if(socket!==current||stopping)return;
 if(u.qr){pairingReady.add(current);log('PAIRING_TRANSPORT_READY');}
 if(u.connection==='open'){phase='CONNECTED';log(phase);stable=setTimeout(()=>{attempt=0;},60000);}
 if(u.connection==='close'){
 if(stable)clearTimeout(stable);socket=undefined;
 const status=(u.lastDisconnect?.error as {output?:{statusCode?:number}}|undefined)?.output?.statusCode;
 log('WA_CLOSE_'+(Number.isInteger(status)?status:'UNKNOWN'));
 if(status===DisconnectReason.restartRequired){timer=setTimeout(()=>{void connect().catch(()=>fail('CONNECT_FAILED'));},1500);return;}
 const decision=reconnect(status===DisconnectReason.loggedOut?'logged-out':status===DisconnectReason.connectionReplaced?'connection-replaced':'transient',attempt++,Math.random());phase=decision.state;log(phase);
 if(decision.delayMs)timer=setTimeout(()=>{void connect().catch(()=>fail('CONNECT_FAILED'));},decision.delayMs);
 }
 });
 current.ev.on('messages.upsert',event=>{
 if(event.type!=='notify'||socket!==current)return;
 for(const message of event.messages){queue=queue.then(async()=>{
 const group=message.key.remoteJid,id=message.key.id;if(stopping||!enabled()||!group?.endsWith('@g.us')||!id||message.key.fromMe)return;
 const body=extractMessageContent(message.message);const text=body?.conversation??body?.extendedTextMessage?.text??'';const context=body?.extendedTextMessage?.contextInfo;
 const self=[current.user?.id,current.user?.lid].filter(Boolean).map(v=>jidNormalizedUser(v!));
 const mention=context?.mentionedJid?.some(j=>self.includes(jidNormalizedUser(j)));
 const reply=context?.participant&&self.includes(jidNormalizedUser(context.participant));
 if(/^!supabase\s*$/i.test(text)&&inChannel(group,'minicamp')&&enabled('minicamp')){
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
  let answer='🗄️ SUPABASE\n⚠️ Diagnóstico indisponível: serviço do Minicamp não configurado.';
  if(cupApi){
   try{const health=await cupApi<{database:boolean}>({action:'health'});answer=health.database===true?'🗄️ SUPABASE\n✅ Conexão com o banco verificada agora.':'🗄️ SUPABASE\n⚠️ O banco não confirmou a verificação.';}
   catch{answer='🗄️ SUPABASE\n⚠️ Não foi possível verificar a conexão agora. Tente novamente em instantes.';}
  }
  if(socket===current&&!stopping&&enabled('minicamp')&&inChannel(group,'minicamp'))await current.sendMessage(group,{text:answer});return;
 }
 if(cupApi&&minicampCommand(text.trim())){
  if(!enabled('minicamp'))return;
  if(!inChannel(group,'minicamp')||!message.key.participant||text.length>1000)return;
  const aliases=await cupAliases(message.key.participant,current);
  if(/^!config(?:\s|$)/i.test(text.trim())){
   await configureCup(group,current);
   const answer=await cupApi<{text:string|null}>({action:'config',event:{group,aliases,id,name:message.pushName??'ADM',text}});
   if(answer.text&&socket===current&&enabled())await current.sendMessage(group,{text:answer.text});return;
  }
  auth.data.cupInbox??=[];
  if(!auth.data.cupInbox.some(e=>e.group===group&&e.id===id&&e.aliases.some(a=>aliases.includes(a)))){
   if(auth.data.cupInbox.length>=100){
    log('MINICAMP_QUEUE_FULL');
    if(socket===current&&enabled('minicamp'))try{await current.sendMessage(group,{text:'⚠️ O Minicamp está com muitas solicitações aguardando. Este comando não foi registrado; tente novamente em instantes.'});}catch{log('MINICAMP_QUEUE_NOTICE_FAILED');}
    return;
   }
   let targets=/^!(?:confronto|carreira|jornada|registrar|associar)\s/i.test(text)&&context?.mentionedJid?.length&&context.mentionedJid.length<=2?await Promise.all(context.mentionedJid.map(j=>cupAliases(j,current))):undefined;
   if(targets?.length&&/^!(?:registrar|associar)\s/i.test(text)){
    const metadata=await current.groupMetadata(group);
    const members=new Set(metadata.participants.map(p=>jidNormalizedUser(p.id)));
    if(!context?.mentionedJid?.every(j=>members.has(jidNormalizedUser(j))))targets=undefined;
   }
   if(/^!sincronizarcontas\s*$/i.test(text)){
    const metadata=await current.groupMetadata(group);
    targets=await Promise.all(metadata.participants.slice(0,100).map(p=>cupAliases(p.id,current)));
   }
   auth.data.cupInbox.push({group,aliases,targets,id,name:message.pushName??'Participante',text:text.trim()});await auth.save();
  }
  void cupTick();return;
 }
 if(!enabled('resenha')||!inChannel(group,'resenha'))return;
 const request=/^!palpite(?:\s|$)/i.test(text)?text.replace(/^!palpite\s*/i,'')+' quem ganha':/^!tecnicos\s*$/i.test(text)?'__LIST_COACHES__':banterRequest(text,Boolean(mention),Boolean(reply));if(request===null)return;
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
 auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);
 let archive='';
 if(cupApi){
  try{
   await configureCup(group,current);
   const query=request.replace(/\b(quem|ganha|vence|leva|melhor|pior|bot|contra|versus|vs|x|fala|sobre|resenha|historico|histórico)\b/gi,' ').trim();
   const context=await cupApi<{enabled:boolean;entries:{body:string;message_date:string;source:string}[]}>({action:'banter-context',group,query:query.slice(0,1000)});
   if(!context.enabled)return;
   const entry=context.entries[0];if(entry)archive='\n\n📚 Do arquivo da resenha ('+entry.message_date+'):\n“'+entry.body+'”\n🍿 Lembrança do chat; não é resultado oficial.';
  }catch{log('HISTORY_LOOKUP_RETRY');return;}
 }
 const response=request==='__LIST_COACHES__'?'🎮 TÉCNICOS DA MASTER LIGA\n'+loadRoster(process.env.MLG_ROSTER_JSON).map(c=>c.name+' — '+c.club).join('\n')+'\nUse nomes completos ou clubes nos palpites.':banterReply(group,request)+archive;
 await auth.save();
 if(socket===current&&!stopping&&inChannel(group,'resenha')&&enabled('resenha')){await current.sendMessage(group,{text:response});log('RESENHA_SENT');}
 }).catch(()=>fail('MESSAGE_PROCESSING_FAILED'));}
 });
}
async function cupAliases(jid:string,current:ReturnType<typeof makeWASocket>):Promise<string[]>{
 const n=jidNormalizedUser(jid);if(!/^[0-9]+@(lid|s\.whatsapp\.net)$/.test(n))throw Error('Unsupported identity');
 const other=n.endsWith('@lid')?await current.signalRepository.lidMapping.getPNForLID(n):await current.signalRepository.lidMapping.getLIDForPN(n);
 return [...new Set([n,...(other?[jidNormalizedUser(other)]:[])])];
}
async function configureCup(group:string,current:ReturnType<typeof makeWASocket>){
 if(configuredCups.has(group))return;
 const metadata=await current.groupMetadata(group);
 const admins=await Promise.all(metadata.participants.filter(p=>p.admin==='admin'||p.admin==='superadmin').map(p=>cupAliases(p.id,current)));
 if(!admins.length||cupClubs.length<16)throw Error('Minicamp setup unavailable');
 await cupApi!({action:'configure',group,admins,clubs:cupClubs});configuredCups.add(group);
}
async function cupTick(){
 if(!cupApi||cupBusy||stopping||!enabled('minicamp')||phase!=='CONNECTED'||!socket)return;cupBusy=true;
 const current=socket;
 try{
  for(const event of (auth.data.cupInbox??[]).slice(0,5)){
   if(!enabled('minicamp'))break;
   if(!inChannel(event.group,'minicamp'))continue;
   await configureCup(event.group,current);await cupApi({action:'event',event});
   auth.data.cupInbox=auth.data.cupInbox!.filter(e=>e!==event);await auth.save();
  }
  const batch=await cupApi<{messages:{id:string;group_id:string;body:string;wa_message_id:string;lease:string}[]}>({action:'poll'});
  for(const m of batch.messages){
   if(!inChannel(m.group_id,'minicamp')||socket!==current||stopping||!enabled('minicamp')){await cupApi({action:'ack',id:m.id,lease:m.lease,sent:false});continue;}
   let sent=false;try{await current.sendMessage(m.group_id,{text:m.body},{messageId:m.wa_message_id});sent=true;}catch{log('MINICAMP_SEND_RETRY');}
   await cupApi({action:'ack',id:m.id,lease:m.lease,sent});
  }
  cupHealthy=true;lastCupTick=lastCupSuccessAt=Date.now();
 }catch{cupHealthy=false;log('MINICAMP_RETRY');}finally{
  cupBusy=false;
  // Drain persisted requests promptly after recovery without overlapping workers.
  if(!stopping&&cupHealthy&&auth.data.cupInbox?.some(e=>inChannel(e.group,'minicamp')))setTimeout(()=>{void cupTick();},250);
 }
}
const controls=createServer(client=>{let buffer='';client.setTimeout(45000,()=>client.destroy());client.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>8192){client.destroy();return;}if(!buffer.includes('\n'))return;client.pause();void(async()=>{
 const req=JSON.parse(buffer.trim());if(req.action==='status')return {controls:auth.data.controls??{enabled:true,resenha:true,minicamp:true},queued:auth.data.cupInbox?.length??0,phase,authorizedGroups:auth.data.groups.length,minicamp:cupApi?(cupHealthy?'READY':'RETRYING'):'DISABLED',minicampLastSuccessAt:lastCupSuccessAt||null,checkedAt:Date.now()};
 if(req.action==='set-group-mode'){
 if(typeof req.group!=='string'||!auth.data.groups.includes(req.group)||!validGroupMode(req.mode))throw Error('Invalid group mode');
 auth.data.groupModes??={};const previous=auth.data.groupModes[req.group];auth.data.groupModes[req.group]=req.mode;
 try{await auth.save();}catch{if(previous)auth.data.groupModes[req.group]=previous;else delete auth.data.groupModes[req.group];throw Error('Mode persistence failed');}
 log('GROUP_MODE_UPDATED');return {updated:true,group:req.group,mode:req.mode};
 }
 if(req.action==='settings'){
 const previous=auth.data.controls;auth.data.controls=parseControls(req.settings);
 try{await auth.save();}catch{auth.data.controls=previous;throw Error('Settings persistence failed');}log('BOT_CONTROLS_UPDATED');return {controls:auth.data.controls,phase,updated:true};
 }
 if(req.action==='revoke'){
 if(typeof req.group!=='string'||!auth.data.groups.includes(req.group))throw Error('Invalid group');
 auth.data.groups=auth.data.groups.filter(g=>g!==req.group);
 if(auth.data.groupModes)delete auth.data.groupModes[req.group];
 auth.data.cupInbox=auth.data.cupInbox?.filter(e=>e.group!==req.group);
 await auth.save();log('GROUP_REVOKED');return {revoked:true};
 }
 if(req.action==='leave-group'){
  if(typeof req.group!=='string'||!req.group.endsWith('@g.us')||auth.data.groups.includes(req.group))throw Error('Revoke group before leaving');
  if(phase!=='CONNECTED'||!socket)throw Error('WhatsApp unavailable');
  const participating=await socket.groupFetchAllParticipating();
  if(!Object.hasOwn(participating,req.group))return {left:true,alreadyLeft:true};
  await socket.groupLeave(req.group);log('UNAUTHORIZED_GROUP_LEFT');return {left:true};
 }
 if(['setadmins','history-candidates','history-review','competition-get','competition-save','templates-list','template-get','template-save','template-activate','template-delete'].includes(req.action)){
 if(!cupApi||!socket||!auth.data.groups.includes(req.group))throw Error('Group unavailable');
 await configureCup(req.group,socket);
 if(req.action==='setadmins'){
  const metadata=await socket.groupMetadata(req.group);
  if(!Array.isArray(req.admins)||req.admins.length<1||req.admins.length>10||!req.admins.every((id:string)=>metadata.participants.some(p=>p.id===id)))throw Error('Invalid admins');
  const admins=await Promise.all(req.admins.map((id:string)=>cupAliases(id,socket!)));
  return cupApi({action:'setadmins',group:req.group,admins,revision:req.revision});
 }
 return cupApi({action:req.action,group:req.group,ids:req.ids,approved:req.approved,name:req.name,teamKind:req.teamKind,formatSize:req.formatSize,teams:req.teams,templateId:req.templateId});
 }
 if(req.action==='pair'){
 if(auth.state.creds.registered||phase==='CONNECTED'||phase==='STOPPED')throw new Error('Pairing unavailable');
 if(!/^\d{10,15}$/.test(req.phone??''))throw new Error('Invalid phone');
 if(timer)clearTimeout(timer);
 // A failed code request sets creds.me before registration. Clear only that
 // incomplete login marker on an explicit retry, never a registered session.
 if(!socket){delete auth.state.creds.me;delete auth.state.creds.pairingCode;await auth.save();await connect();}
 const pairingSocket=socket!;log('PAIRING_REQUEST_STARTED');
 try{const code=await requestReadyPairing(pairingSocket,req.phone,pairingReady.has(pairingSocket),()=>socket===pairingSocket&&!stopping);log('PAIRING_CODE_READY');return {code};}
 catch{log('PAIRING_REQUEST_FAILED');return {error:'Não foi possível preparar a conexão com o WhatsApp. Aguarde 60 segundos e tente novamente.',phase};}
 }
 if(phase!=='CONNECTED'||!socket)throw new Error('Not connected');
 if(req.action==='groups')return {groups:Object.values(await socket.groupFetchAllParticipating()).map(g=>({id:g.id,name:g.subject,authorized:auth.data.groups.includes(g.id),mode:groupMode(auth.data.groupModes,g.id)}))};
 if(typeof req.group!=='string'||!req.group.endsWith('@g.us'))throw new Error('Invalid group');
 const group=await socket.groupMetadata(req.group);
 if(req.action==='participants'){
 let registered:{aliases:string[];revision:string}={aliases:[],revision:''};
 if(cupApi&&auth.data.groups.includes(req.group)){await configureCup(req.group,socket);registered=await cupApi({action:'getadmins',group:req.group});}
 return {revision:registered.revision,participants:await Promise.all(group.participants.map(async p=>{
 const aliases=await cupAliases(p.id,socket!);const phone=aliases.find(a=>a.endsWith('@s.whatsapp.net'))?.split('@')[0];
 return {id:p.id,phone:phone?'+'+phone:p.id,selected:aliases.some(a=>registered.aliases.includes(a))};
 }))};}
 if(req.action==='authorize'){
 if(!group.participants.some(p=>p.id===req.admin))throw new Error('Invalid participant');
 if(!auth.data.groups.includes(req.group))auth.data.groups.push(req.group);
 if(!validGroupMode(req.mode))throw Error('Invalid group mode');auth.data.groupModes??={};auth.data.groupModes[req.group]=req.mode;await auth.save();log('GROUP_AUTHORIZED');return {authorized:true,mode:req.mode};
 }throw new Error('Unknown operation');
 })().then(r=>client.end(JSON.stringify(r)+'\n')).catch(()=>client.end(JSON.stringify({error:'Operação recusada. Confira conexão, número e seleção.'})+'\n'));});});
const health=httpServer((req,res)=>{if(req.url==='/livez'||req.url==='/readyz'){const ok=!stopping&&(req.url==='/livez'||(phase==='CONNECTED'&&(!enabled('minicamp')||!cupApi||(cupHealthy&&Date.now()-lastCupTick<120000))));res.writeHead(ok?200:503,{'Cache-Control':'no-store'}).end(ok?'OK':'UNAVAILABLE');return;}void portal(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
function fail(event:string){log(event);void shutdown(1);}
async function shutdown(code:number){if(stopping)return;stopping=true;if(cupTimer)clearInterval(cupTimer);if(timer)clearTimeout(timer);if(stable)clearTimeout(stable);const deadline=setTimeout(()=>process.exit(code),12000);deadline.unref();controls.close();health.close();socket?.end(undefined);await queue;while(cupBusy)await new Promise(r=>setTimeout(r,50));await auth?.flush();key.fill(0);process.exit(code);}
process.on('SIGTERM',()=>{void shutdown(0);});process.on('SIGINT',()=>{void shutdown(0);});process.on('uncaughtException',()=>fail('UNCAUGHT_ERROR'));process.on('unhandledRejection',()=>fail('UNHANDLED_REJECTION'));
async function main(){auth=await vaultAuth(endpoint!,token!,key);auth.data.replyHistory??={};auth.data.cupInbox??=[];if(cupApi){try{await cupApi({action:'health'});cupHealthy=true;}catch{cupHealthy=false;log('MINICAMP_RETRY');}cupTimer=setInterval(()=>{void cupTick();},15000);}banterReply=createBanterReply(auth.data.replyHistory);await auth.save();await unlink(controlPath).catch(()=>undefined);controls.listen(controlPath,()=>{void chmod(controlPath,0o600).catch(()=>fail('CONTROL_PERMISSIONS_FAILED'));});if(!process.send)health.listen(Number(process.env.PORT??3000),'0.0.0.0');if(auth.state.creds.registered)await connect();else {phase='NEEDS_PAIRING';log(phase);}}
// Parent owns HTTP while this process owns the WhatsApp session and queues.
if(process.send){
 const pulse=setInterval(()=>{if(process.connected)process.send?.({type:'health',phase,ready:!stopping&&phase==='CONNECTED'&&(!enabled('minicamp')||!cupApi||(cupHealthy&&Date.now()-lastCupTick<120000))});},2000);
 pulse.unref();process.on('disconnect',()=>{void shutdown(0);});
}
void main().catch(()=>fail('SESSION_STORAGE_UNAVAILABLE'));
