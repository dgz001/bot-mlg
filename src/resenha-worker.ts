import {financeClient,financialText,financeDisabled} from './finance/client.ts';
import {loanCommand} from './infra/loan-invitation.ts';
import {minicampClubs} from './minicamp/clubs.ts';
import {moduleEnabled,parseControls} from './infra/bot-controls.ts';
import {allowsGroup,groupMode,validGroupMode} from './infra/group-modes.ts';
import {adminControl,type ControlTarget} from './infra/admin-control.ts';
import {whatsappControls} from './infra/whatsapp-controls.ts';
import {minicampClient,minicampCommand,pendingCupBatch,type PendingCupEvent} from './minicamp/client.ts';
import {cupQuestion} from './minicamp/question.ts';
import {cupMediaFor} from './minicamp/media.ts';
import {orderMessages} from './minicamp/message-order.ts';
import {loadRoster} from './resenha/matchup.ts';
import makeWASocket,{DisconnectReason,jidNormalizedUser,extractMessageContent} from '@whiskeysockets/baileys';
import pino from 'pino';
import {banterRequest} from './resenha/trigger.ts';
import {requestReadyPairing} from './whatsapp/pairing.ts';
import {createServer as httpServer} from 'node:http';
import {createServer} from 'node:net';
import {chmod,readFile,unlink} from 'node:fs/promises';
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
if(process.env.FINANCE_ENABLED==='true'&&(!process.env.FINANCE_URL||!process.env.FINANCE_TOKEN))throw Error('Financial release configuration missing');
const financeApi=process.env.FINANCE_ENABLED==='true'&&process.env.FINANCE_URL&&process.env.FINANCE_TOKEN?financeClient(process.env.FINANCE_URL,process.env.FINANCE_TOKEN):undefined;
delete process.env.FINANCE_TOKEN;
let financeHealthy=!financeApi,lastFinanceTick=Date.now();
let financeBusy=false,financeTimer:ReturnType<typeof setInterval>|undefined;
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
 for(const message of orderMessages(event.messages)){queue=queue.then(async()=>{
 const group=message.key.remoteJid,id=message.key.id;if(stopping||!group?.endsWith('@g.us')||!id||message.key.fromMe)return;
 const body=extractMessageContent(message.message);const text=loanCommand((body?.conversation??body?.extendedTextMessage?.text??'').trim());const context=body?.extendedTextMessage?.contextInfo;
 const receivedAt=Number(message.messageTimestamp)*1000;
 const eventAt=Number.isSafeInteger(receivedAt)&&receivedAt>1577836800000&&receivedAt<Date.now()+60000?receivedAt:Date.now();
 // Financial commands are namespaced and disabled unless explicitly released.
 if(financialText(text)){
  if(!auth.data.groups.includes(group)||!message.key.participant)return;
  if(!financeApi){if(socket===current&&!stopping)await current.sendMessage(group,{text:financeDisabled});return;}
  if(!enabled()){if(socket===current&&!stopping)await current.sendMessage(group,{text:'⏸️ Bot pausado. Nenhuma operação financeira foi registrada.'});return;}
  const aliases=await cupAliases(message.key.participant,current);
  const mentioned=context?.mentionedJid??[];let targetAliases:string[]|undefined;
  if(mentioned.length){
   if(mentioned.length!==1){await current.sendMessage(group,{text:'Marque uma única conta para esta operação financeira.'});return;}
   const members=await Promise.all((await current.groupMetadata(group)).participants.map(p=>cupAliases(p.id,current)));
   const target=await cupAliases(mentioned[0]!,current);
   if(!members.some(m=>m.some(j=>target.includes(j)))){await current.sendMessage(group,{text:'A pessoa marcada precisa estar neste grupo.'});return;}
   targetAliases=target;
  }
  auth.data.financeInbox??=[];
  if(!auth.data.financeInbox.some(e=>e.group===group&&e.id===id&&e.aliases.some(a=>aliases.includes(a)))){
   if(auth.data.financeInbox.length>=100){await current.sendMessage(group,{text:'A fila financeira está cheia. Este comando não foi registrado; tente novamente em instantes.'});return;}
   auth.data.financeInbox.push({group,aliases,targetAliases,id,name:message.pushName??'Participante',text});await auth.save();
  }
  void financeTick();return;
 }
 if(!auth.data.groups.includes(group)&&/^!novacopa\s*$/i.test(text.trim())&&cupApi&&message.key.participant){
  try{
   const metadata=await current.groupMetadata(group);
   const aliases=await cupAliases(message.key.participant,current);
   const verified=await Promise.all(metadata.participants.filter(p=>Boolean(p.admin)).map(p=>cupAliases(p.id,current).catch(():string[]=>[])));
   if(!verified.some(a=>a.some(j=>aliases.includes(j))))return;
   const result=await cupApi<{claimed?:boolean;error?:string}>({action:'loan-claim',group,aliases,name:message.pushName??'Organizador'});
   if(result.error)return;
   if(!result.claimed)return;
   auth.data.groups.push(group);auth.data.loanGroups??=[];if(!auth.data.loanGroups.includes(group))auth.data.loanGroups.push(group);auth.data.groupModes??={};auth.data.groupModes[group]='minicamp';
   auth.data.controlRooms??={};auth.data.controlRooms[group]={targetId:group};await auth.save();
  }catch{log('LOAN_CLAIM_RETRY');await current.sendMessage(group,{text:'⚠️ Não consegui ativar o empréstimo agora. Tente !novacopa novamente em instantes.'});return;}
 }
 if(cupApi&&text.trim().startsWith('!')&&message.key.participant&&auth.data.groups.includes(group)){
  const checked=await cupApi<{blocked:boolean}>({action:'block-check',aliases:await cupAliases(message.key.participant,current)});
  if(checked.blocked)return;
 }
 const self=[current.user?.id,current.user?.lid].filter(Boolean).map(v=>jidNormalizedUser(v!));
 const mention=context?.mentionedJid?.some(j=>self.includes(jidNormalizedUser(j)));
 const reply=context?.participant&&self.includes(jidNormalizedUser(context.participant));
 // Power commands must remain reachable in every authorized group while responses are paused.
 const power=whatsappControls(text,auth.data.controls);
 if(power&&auth.data.groups.includes(group)&&groupMode(auth.data.groupModes,group)!=='controle'&&cupApi&&message.key.participant){
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  try{
   const aliases=await cupAliases(message.key.participant,current);
   const members=(await current.groupMetadata(group)).participants;
   if(!members.some(p=>aliases.includes(jidNormalizedUser(p.id)))&&!(await Promise.all(members.map(p=>cupAliases(p.id,current).catch(()=>[])))).some(a=>a.some(j=>aliases.includes(j))))return;
   const permission=await cupApi<{allowed:boolean}>({action:'control-check',group,aliases});
   let response='🔒 Só os ADMs selecionados para este grupo no painel podem controlar o bot.';
   let restartRequested=false;
   if(permission.allowed){
    if(power.next){const previous=auth.data.controls;auth.data.controls=power.next;try{await auth.save();}catch{auth.data.controls=previous;throw Error('Settings persistence failed');}log('BOT_CONTROLS_UPDATED_BY_WA');}
    response=power.restart&&!process.connected?'⚠️ O supervisor de reinício não está disponível. Use o botão Reiniciar no painel.':power.text;
    restartRequested=power.restart===true&&Boolean(process.connected);
   }
   auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
   if(socket===current&&!stopping)await current.sendMessage(group,{text:response});
   if(restartRequested&&socket===current&&!stopping&&process.connected)process.send?.({type:'restart-request'});
  }catch{log('POWER_CONTROL_RETRY');if(socket===current&&!stopping)await current.sendMessage(group,{text:'⚠️ Não foi possível confirmar o comando no banco. Confira o painel antes de repetir.'});}
  return;
 }
 const mode=groupMode(auth.data.groupModes,group);
 const seasonCommand=/^!(?:reiniciartemporada|reiniciar\s+temporada|confirmartemporada|confirmar\s+temporada|cancelartemporada|cancelar\s+temporada)(?:\s|$)/i.test(text.trim());
 const centralOnly=seasonCommand||/^!(?:painel|grupos|usar|central|pendencias|equipes|confirmartimes|adicionar|remover|vagas|revisar|concluir|descartar|adms|daradm|tiraradm|emprestimo|emprestar|devolverbot|inscritosadm|inscrever|retirar|trocar|confirmarelenco|cancelarelenco|bloquear|desbloquear|bloqueados|refazersorteio|confirmarsorteio|cancelarsorteio)(?:\s|$)/i.test(text.trim());
 const outsideCup=!inChannel(group,'minicamp')&&/^!(?:modelos|ativarmodelo|sorteio|novacopa|cancelarcopa|anularcopa|nome|categoria|times|abrircopa|forcarresultado|resolver|deletar|vistoria)(?:\s|$)/i.test(text.trim());
 const loanSetup=/^!(?:novacopa|nome|modalidade|formato|jogos|times|abrircopa|cancelarcopa|modelos)(?:\s|$)/i.test(text.trim());
 if(auth.data.groups.includes(group)&&(mode==='controle'||centralOnly||outsideCup||loanSetup)){
  if(!text.trim().startsWith('!')||!cupApi||!message.key.participant)return;
  if(text.length>16000){await current.sendMessage(group,{text:'⚠️ Mensagem muito longa. Envie os times em mensagens menores com !adicionar.'});return;}
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  try{
   const aliases=await cupAliases(message.key.participant,current);
   const members=(await current.groupMetadata(group)).participants;
   if(!members.some(p=>aliases.includes(jidNormalizedUser(p.id)))&&!(await Promise.all(members.map(p=>cupAliases(p.id,current).catch(()=>[])))).some(a=>a.some(j=>aliases.includes(j))))return;
   const permission=await cupApi<{allowed:boolean;channelAllowed:boolean;loanAllowed:boolean;loanGroup:boolean}>({action:'control-check',group,aliases});
   if(loanSetup&&!centralOnly&&inChannel(group,'minicamp')&&!permission.loanGroup&&!auth.data.loanGroups?.includes(group)&&auth.data.cupInbox!.length<100){
    auth.data.cupInbox!.push({group,aliases,id,name:message.pushName??'Participante',text:text.trim(),at:eventAt});
    auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();void cupTick();return;
   }
   if(!permission.allowed&&permission.channelAllowed&&inChannel(group,'minicamp')&&!centralOnly&&!loanSetup&&auth.data.cupInbox!.length<100){
    auth.data.cupInbox!.push({group,aliases,id,name:message.pushName??'Participante',text:text.trim(),at:eventAt});
    auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();void cupTick();return;
   }
   let response='🔒 Só as contas cadastradas como ADMs no painel podem usar comandos administrativos.';
   let restartRequested=false;
   if(permission.allowed||permission.loanAllowed&&inChannel(group,'minicamp')){
    const loanMode=!permission.allowed;
    if(loanMode&&!enabled('minicamp'))response='⏸️ O bot está pausado. Aguarde um ADM geral da MLG.';
    else if(loanMode||(permission.loanGroup||auth.data.loanGroups?.includes(group))&&/^(?:!(?:painel|central|pendencias|novacopa|nome|modalidade|formato|jogos|equipes|adicionar|remover|times|vagas|revisar|abrircopa|concluir|descartar|cancelarcopa)(?:\s|$))/i.test(text.trim())){
     auth.data.controlRooms??={};const room=auth.data.controlRooms[group]??={};auth.data.controlRooms[group]=room;
     room.targetId=group;
     const target={id:group,name:(await current.groupMetadata(group)).subject};
     const permitted=new Set(['guest-status','guest-open','guest-cancel']);
     const api=async(payload:Record<string,unknown>)=>{
      if(!permitted.has(String(payload.action))||payload.group!==group)return {error:'Operação reservada aos ADMs gerais da MLG.'};
      return cupApi(payload);
     };
     response=await adminControl(text,room,[target],api,()=>auth.save(),Date.now(),{controlGroup:group,aliases,messageId:id},auth.data.controlRooms,true);
    }else{
    const power=whatsappControls(text,auth.data.controls);
    if(power){
     if(power.next){const previous=auth.data.controls;auth.data.controls=power.next;try{await auth.save();}catch{auth.data.controls=previous;throw Error('Settings persistence failed');}log('BOT_CONTROLS_UPDATED_BY_WA');}
     response=power.restart&&!process.connected?'⚠️ O supervisor de reinício não está disponível. Use o botão Reiniciar no painel.':power.text;
     restartRequested=power.restart===true&&Boolean(process.connected);
    }else if(!enabled('minicamp')&&!seasonCommand)response='⏸️ Copa ou bot pausado. Use !acordarbot para liberar os comandos da central.';
    else{
     const participating=Object.values(await current.groupFetchAllParticipating());
     const targets:ControlTarget[]=participating.filter(g=>auth.data.groups.includes(g.id)&&allowsGroup(auth.data.groupModes,g.id,'minicamp')).map(g=>({id:g.id,name:g.subject})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
     auth.data.controlRooms??={};const room=auth.data.controlRooms[group]??={};auth.data.controlRooms[group]=room;
     if(inChannel(group,'minicamp')&&!room.targetId)room.targetId=group;
     const api=async(payload:Record<string,unknown>)=>{
      if(payload.action==='cup-roster'&&payload.change&&payload.targetAliases){
       const metadata=await current.groupMetadata(String(payload.group));
       const members=await Promise.all(metadata.participants.map(p=>cupAliases(p.id,current).catch(():string[]=>[])));
       if(!members.some(m=>m.some(alias=>(payload.targetAliases as string[]).includes(alias))))return {error:'A pessoa já não está no grupo da Copa. A lista não foi alterada.'};
      }
      return cupApi(payload);
     };
     const resolveMember=async(targetGroup:string,phone:string)=>{
      const metadata=await current.groupMetadata(targetGroup),jid=phone+'@s.whatsapp.net';
      const members=await Promise.all(metadata.participants.map(p=>cupAliases(p.id,current).catch(():string[]=>[])));
      return members.find(m=>m.includes(jid))??null;
     };
     const resolveGroupAdmin=async(targetGroup:string,phone:string)=>{
      const metadata=await current.groupMetadata(targetGroup),jid=phone+'@s.whatsapp.net';
      for(const participant of metadata.participants){
       if(!participant.admin)continue;
       const memberAliases=await cupAliases(participant.id,current).catch(():string[]=>[]);
       if(memberAliases.includes(jid))return memberAliases;
      }
      return null;
     };
     const sendInvitation=async(phone:string,guide:string)=>{
      if(socket!==current||stopping||phase!=='CONNECTED')throw Error('WhatsApp unavailable');
      const sent=await current.sendMessage(phone+'@s.whatsapp.net',{text:guide});
      if(!sent?.key.id)throw Error('WhatsApp did not accept guide');
     };
     response=await adminControl(text,room,targets,api,()=>auth.save(),Date.now(),{controlGroup:group,aliases,messageId:id,resolveMember,resolveGroupAdmin,sendInvitation},auth.data.controlRooms);
     if(response.startsWith('✅ TEMPORADA REINICIADA')){
      auth.data.cupInbox=[];auth.data.scoreReactions=[];
      for(const workspace of Object.values(auth.data.controlRooms)){delete workspace.draft;delete workspace.staged;delete workspace.draw;delete workspace.roster;delete workspace.seasonReset;}
      configuredCups.clear();
     }
    }
    }
   }
   auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
   if(socket===current&&!stopping)await current.sendMessage(group,{text:response});
   if(restartRequested&&socket===current&&!stopping&&process.connected)process.send?.({type:'restart-request'});
  }catch{log('ADMIN_CONTROL_RETRY');if(socket===current&&!stopping)await current.sendMessage(group,{text:'⚠️ A central não confirmou este comando no banco. Use !central para conferir a situação antes de repetir.'});}
  return;
 }
 if(!enabled())return;
 if(auth.data.loanGroups?.includes(group)&&inChannel(group,'minicamp')&&cupApi&&message.key.participant&&text.startsWith('!')){
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  const aliases=await cupAliases(message.key.participant,current);
  const result=await cupApi<{accepted?:boolean}>({action:'guest-event',group,aliases,messageId:id,text:text.trim(),name:message.pushName??'Participante'});
  if(result.accepted){auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();void cupTick();}
  return;
 }
 const question=inChannel(group,'minicamp')&&enabled('minicamp')&&cupApi&&message.key.participant?cupQuestion(text):null;
 if(question){
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  const aliases=await cupAliases(message.key.participant!,current);
  const blocked=await cupApi!<{blocked:boolean}>({action:'block-check',aliases});if(blocked.blocked)return;
  auth.data.cupInbox??=[];
  if(auth.data.cupInbox.length>=100){await current.sendMessage(group,{text:'⚠️ Muitas consultas aguardando. Tente !meujogo novamente em instantes.'});return;}
  auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);
  auth.data.cupInbox.push({group,aliases,id,name:message.pushName??'Participante',text:question,at:eventAt});await auth.save();void cupTick();return;
 }
 if(/^!supabase\s*$/i.test(text)&&inChannel(group,'minicamp')&&enabled('minicamp')){
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
  let answer='🗄️ SUPABASE\n⚠️ Diagnóstico indisponível: serviço do Minicamp não configurado.';
  if(cupApi){
   try{const health=await cupApi<{database:boolean}>({action:'health'});answer=health.database===true?'🗄️ SUPABASE\n✅ Conexão com o banco verificada agora.':'🗄️ SUPABASE\n⚠️ O banco não confirmou a verificação.';}
   catch{answer='🗄️ SUPABASE\n⚠️ Não foi possível verificar a conexão agora. Tente novamente em instantes.';}
  }
  if(socket===current&&!stopping&&enabled('minicamp')&&inChannel(group,'minicamp'))await current.sendM