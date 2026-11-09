import {rosterTick,rosterTextReady,rosterMessageId,type RosterConfig} from "./infra/roster-collection.ts";
import {adminAuditTargets,adminAuditBody,auditMessageId,marketWindowCommandAction,marketWindowCommandDelivery} from './infra/admin-audit.ts';
import {isWhatsAppMarketProposalTooLong} from './infra/market-proposal.ts';
import {INITIAL_MARKET_FINANCE,assessLocalMarketFinance} from './infra/market-finance.ts';
import {enqueueLocalMarketProposal,ensureLocalMarketTicketIds,localMarketProposalPage,pendingLocalMarketProposals,completeLocalMarketProposal,parseLocalMarketReviewCommand,MAX_PENDING_LOCAL_MARKET_PROPOSALS} from './infra/local-market-review.ts';
import {loanJoinBatch} from './infra/loan-join-batch.ts';
import {reconcileMarketGroupGate} from './infra/market-group-gate.ts';
import {loanWizard} from './infra/loan-wizard.ts';
import {readMarketCard} from "./infra/market-card.ts";
import {marketResponse} from "./infra/market-response.ts";
import {marketBridge,marketEvent,drainMarketInbox,deliverMarketReactions,canRecoverMarketMessage,marketHealthPayload,marketOperationsPayload,marketNoticeMessageId,type MarketChannel} from "./infra/platform-market.ts";
import {loanCommand} from './infra/loan-invitation.ts';
import {minicampClubs} from './minicamp/clubs.ts';
import {moduleEnabled,parseControls} from './infra/bot-controls.ts';
import {allowsGroup,groupMode,validGroupMode,marketAdminGroups} from './infra/group-modes.ts';
import {adminControl,guestPrepared,type ControlTarget} from './infra/admin-control.ts';
import {whatsappControls} from './infra/whatsapp-controls.ts';
import {minicampClient,minicampCommand,pendingCupBatch,type PendingCupEvent} from './minicamp/client.ts';
import {cupQuestion} from './minicamp/question.ts';
import {cupMediaFor,guestAnnouncementImage} from './minicamp/media.ts';
import {orderMessages} from './minicamp/message-order.ts';
import {loadRoster} from './resenha/matchup.ts';
import makeWASocket,{initAuthCreds,DisconnectReason,jidNormalizedUser,extractMessageContent,downloadContentFromMessage} from '@whiskeysockets/baileys';
import pino from 'pino';
import {banterRequest} from './resenha/trigger.ts';
import {requestReadyPairing,recoverRevokedSession} from './whatsapp/pairing.ts';
import {createServer as httpServer} from 'node:http';
import {createServer} from 'node:net';
import {chmod,readFile,unlink} from 'node:fs/promises';
import {createBanterReply} from './resenha/reply.ts';
import {vaultAuth} from './whatsapp/vault-auth.ts';
import {privateControl} from './infra/private-control.ts';
import {reconnect} from './infra/security.ts';
import {progressMessage} from './whatsapp/progress-message.ts';
import {configureJournal} from './infra/journal-control.ts';
import {newerNews,newsCursor,newsMessage,newsSource} from './infra/platform-news.ts';
process.umask(0o077);
const endpoint=process.env.SESSION_VAULT_URL,token=process.env.SESSION_VAULT_TOKEN,master=process.env.AUTH_ENCRYPTION_KEY;
if(!endpoint||!token||!master||!process.env.CONTROL_PASSWORD||!process.env.CONTROL_ORIGIN)throw new Error('Resenha configuration missing');
const key=Buffer.from(master,/^[a-f0-9]{64}$/i.test(master)?'hex':'base64');
if(key.length!==32)throw new Error('Invalid session key');
const cupApi=process.env.MINICAMP_URL&&process.env.MINICAMP_TOKEN?minicampClient(process.env.MINICAMP_URL,process.env.MINICAMP_TOKEN):undefined;
// Full WhatsApp history sync is opt-in: it can be large and may replay old messages.
// Live messages are always handled normally; enable this only during an intentional archive import.
const syncFullWhatsAppHistory=process.env.WA_SYNC_FULL_HISTORY==='true';
const loadNews=process.env.MLG_NEWS_SUPABASE_URL&&process.env.MLG_NEWS_SUPABASE_KEY?newsSource(process.env.MLG_NEWS_SUPABASE_URL,process.env.MLG_NEWS_SUPABASE_KEY):undefined;
// Transfer proposals remain bot-local until the user explicitly authorizes platform integration.
const marketApi:ReturnType<typeof marketBridge>|undefined=undefined;
delete process.env.MLG_MARKET_BRIDGE_TOKEN;
delete process.env.MLG_NEWS_SUPABASE_KEY;
delete process.env.MINICAMP_TOKEN;
const cupClubs=[...minicampClubs];
const configuredCups=new Set<string>();
let cupBusy=false,lastCupTick=Date.now(),lastCupSuccessAt=0,cupHealthy=!cupApi,cupTimer:ReturnType<typeof setInterval>|undefined;
let rosterCaptureEnabled=false;
let marketSafetySupported=false,marketCaptureSince=0,marketPaused=false,marketDeliveryBlocked=false,lastMarketTick=0,lastMarketSuccessAt=0;
type MarketBatch={group:string;batch:number;count:number;limit?:number;botLocked:boolean};
let marketBusy=false,marketHealthy=!marketApi,marketChannels:MarketChannel[]=[],marketBatches:MarketBatch[]=[],marketTimer:ReturnType<typeof setInterval>|undefined,localMarketTimer:ReturnType<typeof setInterval>|undefined;
let localMarketAuditBusy=false;
type MarketPrivateNotice={id:string;recipient:string;body:string;lease:string};
let newsBusy=false,newsTimer:ReturnType<typeof setInterval>|undefined;
const controlPath='/tmp/mlg-bot-control.sock';
const portal=privateControl({secret:process.env.CONTROL_PASSWORD,origin:process.env.CONTROL_ORIGIN,socketPath:controlPath,resenha:true});
for(const name of ['AUTH_ENCRYPTION_KEY','CONTROL_PASSWORD','SESSION_VAULT_TOKEN','DATABASE_URL','APP_DATABASE_PASSWORD'])delete process.env[name];
const log=(event:string)=>console.log(JSON.stringify({event,at:new Date().toISOString()}));
async function localMarketAuditTick(){
 if(localMarketAuditBusy||!auth||!socket||phase!=='CONNECTED'||stopping||!enabled())return;
 localMarketAuditBusy=true;
 try{
  const groups=adminAuditTargets(auth.data.groups,auth.data.groupModes,auth.data.loanGroups);
  if(!groups.length){if((auth.data.marketInbox??[]).some(e=>e.localOnly&&!e.adminNotified&&typeof e.reviewedAt!=='number'))log('LOCAL_MARKET_ADMIN_GROUP_NOT_CONFIGURED');return;}
  for(const event of (auth.data.marketInbox??[]).filter(e=>e.localOnly&&!e.adminNotified&&typeof e.reviewedAt!=='number').slice(0,10)){
   const body=['📥 NOVA PROPOSTA RECEBIDA — REVISÃO DOS ADMs','Protocolo: '+(event.ticketId??'indisponível'),'Grupo: '+event.group,'Remetente: '+event.participant,'Mensagem: '+event.messageId,'Tipo: '+(event.parsed.kind==='trade'?'Troca':'Transferência'),'Origem: '+event.parsed.origin,'Destino: '+event.parsed.destination,'Jogadores: '+event.parsed.playersFrom.join(', '),'Jogadores recebidos: '+(event.parsed.playersTo.join(', ')||'—'),'Valor informado: '+(event.parsed.amountEuros??'não informado'),'Alertas do livro-caixa: '+(assessLocalMarketFinance(event.parsed,auth.data.marketFinance??INITIAL_MARKET_FINANCE).join(' | ')||'Nenhum alerta automático.'),'Pendências: '+(event.parsed.issues.join('; ')||'Nenhuma detectada pelo parser'),'Status: aguardando conferência manual. Alertas são preventivos; o bot não aprova nem altera saldos ou elencos.'].join('\n');
   let delivered=true;
   for(const group of groups)try{const sent=await socket.sendMessage(group,{text:body},{messageId:auditMessageId(event.messageId,group)});if(!sent?.key.id)throw Error('Admin notice not confirmed');}catch{delivered=false;log('LOCAL_MARKET_ADMIN_NOTICE_RETRY');}
   if(delivered){event.adminNotified=true;try{await auth.save();}catch{event.adminNotified=false;log('LOCAL_MARKET_AUDIT_STATE_SAVE_FAILED');}}
  }
 }finally{localMarketAuditBusy=false;}
}
async function sendBotMessage(current:ReturnType<typeof makeWASocket>,recipient:string,content:any,options?:any){
 const sent=await current.sendMessage(recipient,content,options);
 if(!sent?.key?.id)return sent;
 const targets=adminAuditTargets(auth.data.groups,auth.data.groupModes,auth.data.loanGroups);
 const body=adminAuditBody({at:Date.now(),destination:recipient,messageId:sent.key.id,content});
 for(const group of targets){
  if(group===recipient)continue;
  try{await current.sendMessage(group,{text:body},{messageId:auditMessageId(sent.key.id,group)});}
  catch{log('ADMIN_AUDIT_DELIVERY_FAILED');}
 }
 if(!targets.length)log('ADMIN_AUDIT_GROUP_NOT_CONFIGURED');
 return sent;
}
let phase='STARTING',stopping=false,attempt=0,timer:ReturnType<typeof setTimeout>|undefined,stable:ReturnType<typeof setTimeout>|undefined;
let auth:Awaited<ReturnType<typeof vaultAuth>>,socket:ReturnType<typeof makeWASocket>|undefined;
const pairingReady=new WeakSet<object>();
let queue=Promise.resolve();
let banterReply:ReturnType<typeof createBanterReply>;
const enabled=(module?:'resenha'|'minicamp')=>moduleEnabled(auth.data.controls,module);
const inChannel=(group:string,module:'resenha'|'minicamp')=>auth.data.groups.includes(group)&&allowsGroup(auth.data.groupModes,group,module);
async function connect(){
 if(stopping)return;phase='CONNECTING';
 const current=makeWASocket({auth:auth.state,logger:pino({level:'silent'}),syncFullHistory:syncFullWhatsAppHistory,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>syncFullWhatsAppHistory});socket=current;
	if(syncFullWhatsAppHistory)log('WHATSAPP_FULL_HISTORY_SYNC_ENABLED');
 current.ev.on('creds.update',()=>{if(socket===current)void auth.save().catch(()=>fail('SESSION_SAVE_FAILED'));});
 current.ev.on('connection.update',u=>{
 if(socket!==current||stopping)return;
 if(u.qr){pairingReady.add(current);log('PAIRING_TRANSPORT_READY');}
 if(u.connection==='open'){phase='CONNECTED';log(phase);void marketTick();void loanJoinTick();stable=setTimeout(()=>{attempt=0;},60000);}
 if(u.connection==='close'){
 if(stable)clearTimeout(stable);socket=undefined;
 const status=(u.lastDisconnect?.error as {output?:{statusCode?:number}}|undefined)?.output?.statusCode;
 log('WA_CLOSE_'+(Number.isInteger(status)?status:'UNKNOWN'));
 if(status===DisconnectReason.loggedOut){auth.data.sessionRevoked=true;void auth.save().catch(()=>fail('SESSION_SAVE_FAILED'));}
 if(status===DisconnectReason.restartRequired){timer=setTimeout(()=>{void connect().catch(()=>fail('CONNECT_FAILED'));},1500);return;}
 const decision=reconnect(status===DisconnectReason.loggedOut?'logged-out':status===DisconnectReason.connectionReplaced?'connection-replaced':'transient',attempt++,Math.random());phase=decision.state;log(phase);
 if(decision.delayMs)timer=setTimeout(()=>{void connect().catch(()=>fail('CONNECT_FAILED'));},decision.delayMs);
 }
 });
 const queueLoanJoin=(group:string)=>{queue=queue.then(async()=>{if(stopping||socket!==current)return;auth.data.loanJoinPending??=[];if(!auth.data.loanJoinPending.includes(group)){auth.data.loanJoinPending.push(group);await auth.save();}void loanJoinTick();}).catch(()=>log('LOAN_JOIN_RETRY'));};
 current.ev.on('groups.upsert',groups=>{for(const group of groups)queueLoanJoin(group.id);});
 current.ev.on('group-participants.update',event=>{if(['add','promote'].includes(event.action))queueLoanJoin(event.id);});
 current.ev.on('messages.update',events=>{
  for(const event of events){queue=queue.then(async()=>{
   const group=event.key.remoteJid,id=event.key.id,participant=event.key.participant;
   if(!marketApi||!group||!id||!participant||event.key.fromMe||!enabled()||!auth.data.groups.includes(group)||!marketChannels.some(c=>c.group===group))return;
   const edited=extractMessageContent(event.update.message?.editedMessage?.message??event.update.message);
   const text=(edited?.conversation??edited?.extendedTextMessage?.text??edited?.imageMessage?.caption??'').trim();
   if(!text)return;
   const proposal=marketEvent(group,id,participant,text,marketChannels);
   if(!proposal)return;(proposal.parsed as typeof proposal.parsed & {directoryPhone?:string}).directoryPhone=(await cupAliases(participant,current).catch(()=>[])).find(a=>a.endsWith('@s.whatsapp.net'));proposal.mentions=edited?.extendedTextMessage?.contextInfo?.mentionedJid??edited?.imageMessage?.contextInfo?.mentionedJid??[];
   auth.data.marketInbox??=[];if(!auth.data.marketInbox.some(e=>e.group===group&&e.messageId===id&&e.text===text)){auth.data.marketInbox.push(proposal);await auth.save();}void marketTick();
  }).catch(()=>{log('MARKET_EDIT_CAPTURE_RETRY');});}
 });
 current.ev.on('messages.reaction',events=>{
  for(const event of events){queue=queue.then(async()=>{
   const group=event.key.remoteJid,id=event.reaction.key?.id,participant=event.reaction.key?.participant;
   if(!marketApi||!group||!id||!participant||event.reaction.key?.fromMe||!enabled()||!auth.data.groups.includes(group)||!marketChannels.some(c=>c.group===group))return;
   const response=marketResponse({group,messageId:id,participant,proposalMessageId:event.key.id,reaction:event.reaction.text??undefined});
   if(!response)return;auth.data.marketResponses??=[];
   if(!auth.data.marketResponses.some(e=>e.group===group&&e.messageId===id)){auth.data.marketResponses.push(response);await auth.save();}
   void marketTick();
  }).catch(()=>{log('MARKET_RESPONSE_CAPTURE_RETRY');});}
 });
 current.ev.on('messages.upsert',event=>{
 if(!['notify','append'].includes(event.type)||socket!==current)return;
 for(const message of orderMessages(event.messages)){queue=queue.then(async()=>{
 const group=message.key.remoteJid,id=message.key.id;if(stopping||!group||!id||message.key.fromMe)return;
 const body=extractMessageContent(message.message);const text=loanCommand((body?.conversation??body?.extendedTextMessage?.text??body?.imageMessage?.caption??'').trim());const context=body?.extendedTextMessage?.contextInfo??body?.imageMessage?.contextInfo;
 const windowDelivery=marketWindowCommandDelivery(event.type,text);
 if(windowDelivery==='retry'&&group.endsWith('@g.us')&&auth.data.groups.includes(group)){
  const receivedAt=Number(message.messageTimestamp)*1000;
  if(Number.isFinite(receivedAt)&&receivedAt>Date.now()-2*60*1000&&receivedAt<Date.now()+60000){
   log('LOCAL_MARKET_WINDOW_APPEND_REQUIRES_RETRY');
   await sendBotMessage(current,group,{text:'⚠️ Recebi o comando durante a sincronização do histórico, mas não executei para evitar reabrir a janela por uma mensagem antiga. Reenvie !transligar ou !transdesligar agora.'}).catch(()=>log('LOCAL_MARKET_WINDOW_APPEND_REPLY_FAILED'));
  }
  return;
 }
 if(event.type==='append'&&!canRecoverMarketMessage(event.type,group,message.messageTimestamp,auth.data.marketWindow?.captureSince??0,marketChannels))return;
 if(/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(group)){
  if(marketApi&&enabled()&&event.type==='notify'&&/^(sim|não|nao)$/i.test(text)){
   const aliases=await cupAliases(group,current);const groups=marketAdminGroups(auth.data.groups,auth.data.groupModes,auth.data.loanGroups,auth.data.rosterCollection?.group);
   auth.data.surveyAnswers??=[];if(!auth.data.surveyAnswers.some(e=>e.messageId===id&&e.aliases.includes(group))){auth.data.surveyAnswers.push({aliases,text,messageId:id,groups});await auth.save();}void marketTick();return;
  }
   const collection=auth.data.rosterCollection;
  if(rosterCaptureEnabled&&enabled()&&collection&&!/^!/.test(text)&&event.type==='notify'){
   const aliases=await cupAliases(group,current);
   const entry=collection.entries.find(e=>e.requested&&!e.delivered&&aliases.includes(e.recipient));
   if(entry){
    if(entry.seen.includes(id))return;
    if(text.length>16000){await sendBotMessage(current,group,{text:'A lista excedeu o tamanho permitido. Envie a lista completa em uma mensagem menor.'});return;}
    if(body?.imageMessage)entry.image=body.imageMessage;
    if(text&&(/goleir/i.test(text)||(!entry.text&&!body?.imageMessage)))entry.text=text;
    entry.seen.push(id);entry.seen=entry.seen.slice(-50);await auth.save();
    const reply=!entry.image?'Recebi a lista. Falta a foto do elenco.':!entry.text?'Recebi a foto. Falta a lista completa por posições.':!rosterTextReady(entry.text)?'Confira a lista: inclua a seção GOLEIROS com pelo menos dois nomes e o elenco completo por posições.':'Foto e lista recebidas. Vou encaminhar ao grupo de elencos para conferência dos ADMs.';
    await sendBotMessage(current,group,{text:reply},{messageId:rosterMessageId(collection.run,entry.club,'receipt-'+id)});void marketTick();return;
   }
  }
 if(!cupApi||!(/^!(?:configbot|alterarconfig|cancelarconfig|rejeitar|novacopa|nome|modalidade|formato|vagas|classificados|jogos|equipes|adicionar|remover|corrigirclubes|times|revisar|confirmar|descartar|central|pendencias|painel|ajuda|comandos|imagemgrupo|imagemtexto)(?:\s|$)/i.test(text)||Object.values(auth.data.controlRooms??{}).some(r=>r.guestWizard)))return;
  const dedup=JSON.stringify([group,id]);if(auth.data.seen.includes(dedup))return;
  if(text.length>16000){await sendBotMessage(current,group,{text:'⚠️ Lista muito longa. Envie em partes com !adicionar.'});return;}
  let finish:ReturnType<typeof progressMessage>|undefined;
  try{
  const aliases=await cupAliases(group,current);
  const check=await cupApi<{allowed:boolean;manager?:string;claimedGroup?:string|null;grantedAt?:number}>({action:'loan-private-check',aliases});
  if(!check.allowed||!check.manager||!Number.isFinite(check.grantedAt))return;
  finish=progressMessage(current,group,()=>socket===current&&!stopping);
  auth.data.controlRooms??={};const key=check.claimedGroup??'loan-private:'+check.manager,previous=auth.data.controlRooms['loan-private:'+check.manager],room=auth.data.controlRooms[key]??previous??{};auth.data.controlRooms[key]=room;room.targetId=check.claimedGroup??'private';
  if(room.guestInvitationAt!==check.grantedAt){if(room.guestInvitationAt!=null){delete room.guestDraft;delete room.guestImage;delete room.guestWizard;}room.guestInvitationAt=check.grantedAt;await auth.save();}
  const response=await loanWizard(text,room,()=>auth.save())??await adminControl(text,room,[],async()=>({error:'Operação indisponível no privado.'}),()=>auth.save(),Date.now(),{controlGroup:group,aliases,messageId:id},auth.data.controlRooms,true,true);
  auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
  await finish(response);
  }catch{log('LOAN_PRIVATE_RETRY');if(finish)await finish('⚠️ Não consegui salvar agora. Tente o comando novamente em instantes.').catch(()=>{});}
  return;
 }
 if(!group.endsWith('@g.us'))return;
 const reviewCommand=event.type==='notify'?parseLocalMarketReviewCommand(text):null;
 const reviewGroupMode=groupMode(auth.data.groupModes,group);
 const reviewActor=message.key.participant;
 if(reviewCommand&&auth.data.groups.includes(group)&&['controle','transfer','trade'].includes(reviewGroupMode)&&reviewActor){
  const current=socket;
  if(!current)return;
  const actor:string[]=await cupAliases(reviewActor,current).catch(()=>[] as string[]);
  const authorizationGroups=reviewGroupMode==='controle'?[group]:adminAuditTargets(auth.data.groups,auth.data.groupModes,auth.data.loanGroups);
  let authorized=false;
  for(const adminGroup of authorizationGroups){
   try{
    const metadata=await current.groupMetadata(adminGroup);
    for(const member of metadata.participants){
     if(!member.admin)continue;
     const aliases=await cupAliases(member.id,current).catch(()=>[]);
     if(aliases.some(alias=>actor.includes(alias))){authorized=true;break;}
    }
   }catch{log('LOCAL_MARKET_REVIEW_AUTH_RETRY');}
   if(authorized)break;
  }
  if(!authorized){await sendBotMessage(current,group,{text:'🔒 Somente um administrador do grupo administrativo configurado pode consultar ou encerrar revisões locais.'});return;}
  if(reviewCommand.action==='list'){
   const page=localMarketProposalPage(auth.data,reviewCommand.page,15);
   if(reviewCommand.page>page.pageCount){await sendBotMessage(current,group,{text:'Página inexistente. Há '+page.pageCount+' página(s) de propostas pendentes.'});return;}
   const lines=page.items.map(item=>{
    const amount=item.parsed.amountEuros===null?'valor não informado':'€'+Number(item.parsed.amountEuros).toLocaleString('pt-BR',{maximumFractionDigits:0});
    const pending=item.parsed.issues.length?' ⚠️ '+item.parsed.issues.join('; '):'';
    return (item.ticketId??'SEM-ID')+' | '+(item.parsed.kind==='trade'?'TROCA':'COMPRA')+' | '+item.parsed.origin+' → '+item.parsed.destination+' | '+amount+' | '+item.parsed.playersFrom.join(', ')+(item.parsed.playersTo.length?' ↔ '+item.parsed.playersTo.join(', '):'')+pending;
   });
   const body=['📥 FILA LOCAL DE REVISÃO — MLG','Pendentes: '+page.total+' | Página '+page.page+'/'+page.pageCount,...(lines.length?lines:['Nenhuma proposta pendente.']),'Para encerrar uma revisão já conferida: !proposta concluir <ID>','Encerrar a revisão não aprova contrato nem altera saldo, elenco ou cotas.'].join('\n');
   await sendBotMessage(current,group,{text:body});return;
  }
  const target=(auth.data.marketInbox??[]).find(item=>item.localOnly&&item.ticketId===reviewCommand.ticketId);
  if(!target){await sendBotMessage(current,group,{text:'⚠️ Protocolo não encontrado. Consulte !propostas para copiar um ID válido.'});return;}
  if(typeof target.reviewedAt==='number'){await sendBotMessage(current,group,{text:'ℹ️ A proposta '+reviewCommand.ticketId+' já foi encerrada na fila em '+new Date(target.reviewedAt).toLocaleString('pt-BR')+'.'});return;}
  const previousInbox=auth.data.marketInbox?.map(item=>({...item}));
  const result=completeLocalMarketProposal(auth.data,reviewCommand.ticketId,actor[0]??reviewActor);
  if(result.status!=='reviewed'){await sendBotMessage(current,group,{text:'⚠️ Não consegui alterar o estado desta revisão. Consulte !propostas e tente novamente.'});return;}
  try{await auth.save();}
  catch{auth.data.marketInbox=previousInbox;await sendBotMessage(current,group,{text:'⚠️ Não consegui salvar a revisão. Nenhuma alteração financeira foi realizada; tente novamente.'});return;}
  await sendBotMessage(current,group,{text:'✅ Protocolo '+reviewCommand.ticketId+' marcado como revisão encerrada pelo ADM. Isso apenas arquiva a pendência local: não aprova contrato, não altera saldo, elenco nem cotas.'});
  return;
 }
 if(windowDelivery==='execute'){
  const commandMode=groupMode(auth.data.groupModes,group);
  log('LOCAL_MARKET_WINDOW_COMMAND_RECEIVED');
  if(!auth.data.groups.includes(group)){
   log('LOCAL_MARKET_WINDOW_GROUP_NOT_AUTHORIZED');
   await sendBotMessage(current,group,{text:'🔒 Este grupo recebeu o comando, mas não está cadastrado como grupo autorizado do bot. Confira o cadastro no painel antes de tentar novamente.'}).catch(()=>log('LOCAL_MARKET_WINDOW_REPLY_FAILED'));
   return;
  }
  if(!['controle','transfer','trade'].includes(commandMode)){
   log('LOCAL_MARKET_WINDOW_GROUP_MODE_REJECTED');
   await sendBotMessage(current,group,{text:'⚠️ O comando chegou ao bot, mas este grupo está configurado no modo "'+commandMode+'". Para controlar a janela, configure Administração Bot como "controle" no painel do Render.'}).catch(()=>log('LOCAL_MARKET_WINDOW_REPLY_FAILED'));
   return;
  }
  try{
   const participant=message.key.participant??(message.key as typeof message.key & {participantAlt?:string}).participantAlt;
   if(!participant){
    log('LOCAL_MARKET_WINDOW_SENDER_ID_MISSING');
    await sendBotMessage(current,group,{text:'⚠️ Recebi o comando, mas o WhatsApp não informou a identidade do remetente. Tente novamente.'});
    return;
   }
   const actor=await cupAliases(participant,current);
   const adminGroups=adminAuditTargets(auth.data.groups,auth.data.groupModes,auth.data.loanGroups);
   const commandFromControl=commandMode==='controle';
   const marketGroups=auth.data.groups.filter(g=>['transfer','trade'].includes(groupMode(auth.data.groupModes,g))&&!auth.data.loanGroups?.includes(g)).sort();
   let authorized=false;
   const authorizationGroups=commandFromControl?[group]:[...new Set([group,...adminGroups])];
   for(const adminGroup of authorizationGroups){
    const metadata=await current.groupMetadata(adminGroup);
    for(const member of metadata.participants){
     if(!member.admin)continue;
     const aliases=await cupAliases(member.id,current).catch(()=>[]);
     if(aliases.some(alias=>actor.includes(alias))){authorized=true;break;}
    }
    if(authorized)break;
   }
   if(!authorized){log('LOCAL_MARKET_WINDOW_COMMAND_UNAUTHORIZED');await sendBotMessage(current,group,{text:'🔒 O comando foi recebido, mas o remetente não foi identificado como administrador deste grupo.'});return;}
   if(commandFromControl&&!marketGroups.length){await sendBotMessage(current,group,{text:'⚠️ Não encontrei nenhum grupo autorizado como transferências/trocas. Configure ao menos um grupo com modo transfer ou trade.'});return;}
   const open=marketWindowCommandAction(text)==='open';
   const previous=auth.data.marketWindow??{open:false,captureSince:0};
   if(open&&previous.open){await sendBotMessage(current,group,{text:'🟢 A janela de transferências do bot já está ligada. Não reiniciei a captura nem recapturei mensagens antigas.'});return;}
   if(!open&&!previous.open){await sendBotMessage(current,group,{text:'⚪ A janela do bot já está desligada.'});return;}
   auth.data.marketWindow=open?{open:true,captureSince:Date.now()}:{...previous,open:false,closedAt:Date.now()};
   try{await auth.save();}catch(error){auth.data.marketWindow=previous;throw error;}
   const body=open?'🟢 JANELA DE TRANSFERÊNCIAS LIGADA NO BOT. A captura começa agora; mensagens anteriores não serão processadas.':'🔴 JANELA DE TRANSFERÊNCIAS DESLIGADA NO BOT. Novas propostas não serão capturadas.';
   await sendBotMessage(current,group,{text:body+(commandFromControl?'\nGrupos monitorados: '+marketGroups.length:'')});
   if(!commandFromControl)for(const adminGroup of adminGroups)if(adminGroup!==group)await sendBotMessage(current,adminGroup,{text:body+'\nGrupo de mercado: '+group});
  }catch{log('LOCAL_MARKET_WINDOW_COMMAND_FAILED');await sendBotMessage(current,group,{text:'⚠️ Não consegui confirmar a alteração. Consulte !statusbot antes de repetir.'}).catch(()=>{});}
  return;
 }
 if(['transfer','trade'].includes(groupMode(auth.data.groupModes,group))&&!auth.data.marketWindow?.open)return;
 if(enabled()&&auth.data.groups.includes(group)&&message.key.participant&&['transfer','trade'].includes(groupMode(auth.data.groupModes,group))){
  if(isWhatsAppMarketProposalTooLong(text)){
   await sendBotMessage(current,group,{text:'❌ Mensagem não processada: o limite é de 16.000 caracteres. Divida a proposta em uma mensagem menor. O bot continua funcionando.'});
   return;
  }
  const channels:MarketChannel[]=auth.data.groups.filter(g=>['transfer','trade'].includes(groupMode(auth.data.groupModes,g))).map(g=>({group:g,kind:groupMode(auth.data.groupModes,g) as 'transfer'|'trade'}));
  const localProposal=marketEvent(group,id,message.key.participant,text,channels);
  if(localProposal){
   auth.data.marketInbox??=[];
   const previousInbox=[...auth.data.marketInbox];
   const queueResult=enqueueLocalMarketProposal(auth.data,{...localProposal,localOnly:true,adminNotified:false});
   if(queueResult==='full'){
    await sendBotMessage(current,group,{text:'🚨 FILA DE REVISÃO CHEIA: existem '+MAX_PENDING_LOCAL_MARKET_PROPOSALS+' propostas pendentes. Esta proposta NÃO foi registrada. Aguarde um ADM consultar !propostas e encerrar uma revisão já conferida. Não reenvie repetidamente.'});
    return;
   }
   if(queueResult==='queued'){
    try{await auth.save();}catch(error){auth.data.marketInbox=previousInbox;throw error;}
    const accepted=auth.data.marketInbox.find(e=>e.localOnly&&e.group===group&&e.messageId===id);
    const ticket=accepted?.ticketId??'indisponível';
    const issues=localProposal.parsed.issues;
    const reaction=issues.length?'❌':'🟠';
    try{await sendBotMessage(current,group,{react:{text:reaction,key:{remoteJid:group,participant:message.key.participant,id,fromMe:false}}});}catch{log('LOCAL_MARKET_REACTION_RETRY');}
    const phone=(await cupAliases(message.key.participant,current).catch(()=>[])).find(a=>a.endsWith('@s.whatsapp.net'));
    if(phone){
     const dm=issues.length?'❌ Protocolo '+ticket+' recebido, mas há pendências: '+issues.join('; ')+'. Corrija os campos e envie uma nova proposta.':localProposal.parsed.purchaseScope==='review'?'🟠 Protocolo '+ticket+' recebido, mas o tipo ainda não está claro. Identifique se é COMPRA INTERNA (de outro clube da MLG) ou COMPRA EXTERNA (jogador de fora da MLG). A proposta ficará aguardando os ADMs.':'🟠 Protocolo '+ticket+' recebido e encaminhado para revisão dos ADMs. Ainda não está aprovado nem concluído.';
     await sendBotMessage(current,phone,{text:dm}).catch(()=>log('LOCAL_MARKET_PRIVATE_NOTICE_RETRY'));
    }
   }
   void localMarketAuditTick();return;
  }
 }
 // Local confirmations are captured independently of the optional platform bridge.
 // A quoted reply is linked by stanzaId; an unquoted reply is accepted only when
 // the sender was explicitly mentioned on exactly one pending proposal in this group.
 if(event.type==='notify'&&enabled()&&auth.data.groups.includes(group)&&auth.data.marketWindow?.open&&['transfer','trade'].includes(groupMode(auth.data.groupModes,group))){
  const reactionMessage=body?.reactionMessage;
  const responseEvent=marketResponse({group,messageId:id,participant:message.key.participant??(message.key as typeof message.key & {participantAlt?:string}).participantAlt??'',proposalMessageId:reactionMessage?.key?.id??context?.stanzaId,text:reactionMessage?undefined:text,reaction:reactionMessage?.text??undefined});
  if(responseEvent){
   const candidates=(auth.data.marketInbox??[]).filter(item=>item.localOnly&&item.group===group&&typeof item.reviewedAt!=='number'&&(!responseEvent.proposalMessageId||item.messageId===responseEvent.proposalMessageId));
   let target=responseEvent.proposalMessageId&&candidates.length===1?candidates[0]:undefined;
   if(!responseEvent.proposalMessageId){
    const sender=message.key.participant??(message.key as typeof message.key & {participantAlt?:string}).participantAlt;
    if(sender){
     const aliases=await cupAliases(sender,current).catch(()=>[sender]);
     const mentioned=(auth.data.marketInbox??[]).filter(item=>item.localOnly&&item.group===group&&typeof item.reviewedAt!=='number'&&(item.mentions??[]).some(jid=>aliases.includes(jid)));
     if(mentioned.length===1)target=mentioned[0];
    }
   }
   if(target){
    target.responses??=[];
    if(!target.responses.some(item=>item.messageId===id)){
     const previous=target.responses.slice();
     target.responses.push({...responseEvent,proposalMessageId:target.messageId});
     try{await auth.save();}
     catch{target.responses=previous;log('LOCAL_MARKET_CONFIRMATION_SAVE_FAILED');return;}
     log(responseEvent.decision==='positive'?'LOCAL_MARKET_CONFIRMATION_CAPTURED':responseEvent.decision==='negative'?'LOCAL_MARKET_REJECTION_CAPTURED':'LOCAL_MARKET_RESPONSE_CAPTURED');
     const adminGroups=adminAuditTargets(auth.data.groups,auth.data.groupModes,auth.data.loanGroups);
     const status=responseEvent.decision==='positive'?'CONFIRMAÇÃO POSITIVA':responseEvent.decision==='negative'?'RECUSA REGISTRADA':'RESPOSTA REGISTRADA';
     const notice=['📌 ATUALIZAÇÃO DE PROPOSTA — MLG', 'Protocolo: '+(target.ticketId??'indisponível'),'Clube/jogadores: '+target.parsed.origin+' → '+target.parsed.destination+' | '+target.parsed.playersFrom.join(', ')+' ↔ '+target.parsed.playersTo.join(', '),status,'Resposta: '+responseEvent.text,'Remetente: '+responseEvent.participant,'A proposta continua aguardando conferência dos ADMs; nenhuma operação financeira foi executada.'].join('\\n');
     for(const adminGroup of adminGroups)try{await sendBotMessage(current,adminGroup,{text:notice});}catch{log('LOCAL_MARKET_CONFIRMATION_NOTICE_RETRY');}
    }
    return;
   }
   log('LOCAL_MARKET_CONFIRMATION_UNMATCHED');
  }
 }
 if(marketApi&&enabled()&&message.key.participant&&auth.data.groups.includes(group)){
  if(marketChannels.some(c=>c.group===group)){
   const reaction=body?.reactionMessage;
   const response=marketResponse({group,messageId:id,participant:message.key.participant,proposalMessageId:reaction?.key?.id??context?.stanzaId,text,reaction:reaction?.text??undefined});
   if(response){auth.data.marketResponses??=[];if(!auth.data.marketResponses.some(e=>e.group===group&&e.messageId===id)){auth.data.marketResponses.push(response);await auth.save();}void marketTick();return;}
  }


  let proposal=marketEvent(group,id,message.key.participant,text,marketChannels);
  if(proposal&&body?.imageMessage&&marketChannels.some(c=>c.group===group)){
   try{
    const stream=await downloadContentFromMessage(body.imageMessage,'image');let size=0;const chunks:Buffer[]=[];
    for await(const chunk of stream){size+=chunk.length;if(size>4*1024*1024)throw Error('Card image too large');chunks.push(Buffer.from(chunk));}
    const reading=await readMarketCard(Buffer.concat(chunks),text);
    if(!proposal){proposal=marketEvent(group,id,message.key.participant,'PROPOSTA DE COMPRA\n'+text,marketChannels);if(proposal){proposal.text=text||'[Carta recebida sem modelo de proposta]';proposal.parsed.issues.push('Carta recebida sem proposta completa: associe o jogador externo e o destino antes de continuar.');}}
    if(proposal)proposal.cardReading=reading;
   }catch{if(!proposal){proposal=marketEvent(group,id,message.key.participant,'PROPOSTA DE COMPRA\n'+text,marketChannels);if(proposal)proposal.text=text||'[Carta recebida sem modelo de proposta]';}if(proposal)proposal.parsed.issues.push('A leitura da carta não foi confirmada. Confira a imagem original.');log('MARKET_CARD_REVIEW_REQUIRED');}
  }

  if(proposal){
   (proposal.parsed as typeof proposal.parsed & {directoryPhone?:string}).directoryPhone=(await cupAliases(message.key.participant,current).catch(()=>[])).find(a=>a.endsWith('@s.whatsapp.net'));
   proposal.mentions=context?.mentionedJid??[];
   auth.data.marketInbox??=[];
   if(!auth.data.marketInbox.some(e=>e.group===group&&e.messageId===id&&e.text===text)){
    auth.data.marketInbox.push(proposal);await auth.save();
   }
   void marketTick();return;
  }
  if(marketChannels.some(c=>c.group===group)){
   // Notices, examples and discussion do not create proposals or trigger warnings.
   return;
  }
 }

 if(auth.data.groups.includes(group)&&['transfer','trade','market-loan','roster'].includes(groupMode(auth.data.groupModes,group)))return;
 const receivedAt=Number(message.messageTimestamp)*1000;
 const eventAt=Number.isSafeInteger(receivedAt)&&receivedAt>1577836800000&&receivedAt<Date.now()+60000?receivedAt:Date.now();
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
  }catch{log('LOAN_CLAIM_RETRY');await sendBotMessage(current,group,{text:'⚠️ Não consegui ativar o empréstimo agora. Tente !novacopa novamente em instantes.'});return;}
 }
 if(cupApi&&text.trim().startsWith('!')&&message.key.participant&&auth.data.groups.includes(group)){
  const checked=await cupApi<{blocked:boolean}>({action:'block-check',aliases:await cupAliases(message.key.participant,current)});
  if(checked.blocked)return;
 }
 if(/^!jornal(?:\s|$)/i.test(text)&&message.key.participant&&auth.data.groups.includes(group)){
  if(!cupApi)return;
  try{
   const aliases=await cupAliases(message.key.participant,current);
   const permission=await cupApi<{allowed:boolean}>({action:'control-check',group,aliases});
   if(!permission.allowed){await sendBotMessage(current,group,{text:'🔒 Somente um ADM geral da MLG pode configurar o jornal.'});return;}
   const choice=text.replace(/^!jornal\s*/i,'').trim().toLowerCase();
   let response:string;
   if(choice==='status'||choice==='')response=auth.data.newsGroup?'📰 Jornal automático ativo no grupo '+(await current.groupMetadata(auth.data.newsGroup)).subject+'.':'📰 Jornal automático sem grupo definido. Use !jornal aqui no grupo desejado.';
   else if(choice==='desligar'){delete auth.data.newsGroup;await auth.save();response='📰 Envio automático do jornal desligado.';}
   else if(choice==='aqui'){
    if(!loadNews)response='⚠️ A fonte de notícias ainda não está configurada no servidor.';
    else if(auth.data.loanGroups?.includes(group))response='⚠️ O jornal MLG não pode ser ativado em grupo emprestado.';
    else {const latest=(await loadNews())[0];auth.data.newsCursor=latest?newsCursor(latest):{publishedAt:new Date().toISOString(),id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};auth.data.newsGroup=group;await auth.save();response='📰 Jornal ativado neste grupo. As próximas notícias publicadas na plataforma serão enviadas automaticamente. Publicações antigas não serão repetidas.';}
   }else response='Use !jornal aqui, !jornal status ou !jornal desligar.';
   await sendBotMessage(current,group,{text:response});
  }catch{log('NEWS_CONTROL_RETRY');await sendBotMessage(current,group,{text:'⚠️ Não consegui configurar o jornal agora. Tente novamente.'}).catch(()=>{});}
  return;
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
   if(socket===current&&!stopping)await sendBotMessage(current,group,{text:response});
   if(restartRequested&&socket===current&&!stopping&&process.connected)process.send?.({type:'restart-request'});
  }catch{log('POWER_CONTROL_RETRY');if(socket===current&&!stopping)await sendBotMessage(current,group,{text:'⚠️ Não foi possível confirmar o comando no banco. Confira o painel antes de repetir.'});}
  return;
 }
 const mode=groupMode(auth.data.groupModes,group);
 const seasonCommand=/^!(?:reiniciartemporada|reiniciar\s+temporada|confirmartemporada|confirmar\s+temporada|cancelartemporada|cancelar\s+temporada)(?:\s|$)/i.test(text.trim());
 const centralOnly=seasonCommand||/^!(?:painel|grupos|usar|central|pendencias|equipes|confirmartimes|adicionar|remover|corrigirclubes|vagas|classificados|revisar|concluir|descartar|adms|daradm|tiraradm|emprestimo|emprestar|devolverbot|inscritosadm|inscrever|retirar|trocar|confirmarelenco|cancelarelenco|bloquear|desbloquear|bloqueados|refazersorteio|confirmarsorteio|cancelarsorteio)(?:\s|$)/i.test(text.trim());
 const outsideCup=!inChannel(group,'minicamp')&&/^!(?:modelos|ativarmodelo|sorteio|novacopa|cancelarcopa|anularcopa|nome|categoria|times|abrircopa|forcarresultado|resolver|deletar|vistoria)(?:\s|$)/i.test(text.trim());
 const loanSetup=/^!(?:novacopa|nome|modalidade|formato|jogos|classificados|times|abrircopa|cancelarcopa|cancelar\s+copa|modelos|imagemgrupo|imagemtexto|corrigirclubes|daradm|tiraradm|adms)(?:\s|$)/i.test(text.trim());
 if(auth.data.groups.includes(group)&&(mode==='controle'||centralOnly||outsideCup||loanSetup)){
  if(!text.trim().startsWith('!')||!cupApi||!message.key.participant)return;
  if(text.length>16000){await sendBotMessage(current,group,{text:'⚠️ Mensagem muito longa. Envie os times em mensagens menores com !adicionar.'});return;}
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  let finish:ReturnType<typeof progressMessage>|undefined;
  try{
   const aliases=await cupAliases(message.key.participant,current);
   const members=(await current.groupMetadata(group)).participants;
   if(!members.some(p=>aliases.includes(jidNormalizedUser(p.id)))&&!(await Promise.all(members.map(p=>cupAliases(p.id,current).catch(()=>[])))).some(a=>a.some(j=>aliases.includes(j))))return;
   const permission=await cupApi<{allowed:boolean;channelAllowed:boolean;loanAllowed:boolean;loanGroup:boolean}>({action:'control-check',group,aliases});
   if(loanSetup&&!centralOnly&&inChannel(group,'minicamp')&&!permission.loanGroup&&!auth.data.loanGroups?.includes(group)&&auth.data.cupInbox!.length<100){
    auth.data.cupInbox!.push({group,aliases,id,name:message.pushName??'Participante',text:text.trim(),at:eventAt});
    auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();void cupTick();return;
   }
   if(!permission.allowed&&permission.channelAllowed&&inChannel(group,'minicamp')&&!permission.loanGroup&&!centralOnly&&!loanSetup&&auth.data.cupInbox!.length<100){
    auth.data.cupInbox!.push({group,aliases,id,name:message.pushName??'Participante',text:text.trim(),at:eventAt});
    auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();void cupTick();return;
   }
   finish=progressMessage(current,group,()=>socket===current&&!stopping);
   let response='🔒 Só as contas cadastradas como ADMs no painel podem usar comandos administrativos.';
   let restartRequested=false;
   if(permission.allowed||permission.loanAllowed&&inChannel(group,'minicamp')){
    const loanMode=!permission.allowed;
    if(loanMode&&!enabled('minicamp'))response='⏸️ O bot está pausado. Aguarde um ADM geral da MLG.';
    else if(loanMode||(permission.loanGroup||auth.data.loanGroups?.includes(group))&&/^(?:!(?:painel|central|pendencias|novacopa|nome|modalidade|formato|jogos|classificados|equipes|adicionar|remover|corrigirclubes|times|vagas|revisar|abrircopa|concluir|descartar|cancelarcopa|cancelar\s+copa|imagemgrupo|imagemtexto|daradm|tiraradm|adms)(?:\s|$))/i.test(text.trim())){
     auth.data.controlRooms??={};const room=auth.data.controlRooms[group]??={};auth.data.controlRooms[group]=room;
     room.targetId=group;
     const target={id:group,name:(await current.groupMetadata(group)).subject};
     const permitted=new Set(['guest-status','guest-open','guest-cancel','guest-admin']);
     const api=async(payload:Record<string,unknown>)=>{
      if(!permitted.has(String(payload.action))||payload.group!==group)return {error:'Operação reservada aos ADMs gerais da MLG.'};
      return cupApi(payload);
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
     const privateCheck=/^!novacopa\s*$/i.test(text.trim())?await cupApi<{allowed:boolean;manager?:string;claimedGroup?:string|null;grantedAt?:number}>({action:'loan-private-check',aliases}).catch(()=>null):null;
     const privateRoom=privateCheck?.allowed&&(!privateCheck.claimedGroup||privateCheck.claimedGroup===group)?(privateCheck.claimedGroup?auth.data.controlRooms[group]:auth.data.controlRooms['loan-private:'+privateCheck.manager]):undefined;
     if(privateRoom&&privateRoom.guestInvitationAt!=null&&privateRoom.guestInvitationAt!==privateCheck?.grantedAt){delete privateRoom.guestDraft;delete privateRoom.guestImage;privateRoom.guestInvitationAt=privateCheck?.grantedAt;await auth.save();}
     const prepared=privateRoom?guestPrepared(privateRoom):null;
     if(prepared){
      const opened=await api({action:'guest-open',group,...prepared});
      if(opened.error)response='⚠️ '+opened.error+' O preparo continua salvo no privado.';
      else{
       room.guestImage=privateRoom?.guestImage??'text';delete privateRoom!.guestDraft;await auth.save();
       response=`🏆 ${prepared.name} · inscrições abertas para ${prepared.size} jogadores! ${prepared.mode==='liga'?'Pontos corridos':prepared.mode==='copa'?'Mata-mata':'Pontos corridos → mata-mata'+` · ${prepared.qualifiers} avançam`}, ${prepared.legs===2?'ida e volta':'jogo único'}. Enviem !entrar. Ao completar as vagas, o bot anuncia os confrontos e explica !resultado CÓDIGO MxV.`;
      }
     }else response=await adminControl(text,room,[target],api,()=>auth.save(),Date.now(),{controlGroup:group,aliases,messageId:id,resolveGroupAdmin},auth.data.controlRooms,true);
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
     const resolveMemberAnywhere=async(phone:string)=>{
      for(const target of targets){
       const found=await resolveMember(target.id,phone).catch(()=>null);
       if(found)return found;
      }
      return null;
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
      const sent=await sendBotMessage(current,phone+'@s.whatsapp.net',{text:guide});
      if(!sent?.key.id)throw Error('WhatsApp did not accept guide');
     };
     response=await adminControl(text,room,targets,api,()=>auth.save(),Date.now(),{controlGroup:group,aliases,messageId:id,resolveMember,resolveMemberAnywhere,resolveGroupAdmin,sendInvitation},auth.data.controlRooms);
     if(response.startsWith('✅ TEMPORADA REINICIADA')){
      auth.data.cupInbox=[];auth.data.scoreReactions=[];
      for(const workspace of Object.values(auth.data.controlRooms)){delete workspace.draft;delete workspace.staged;delete workspace.draw;delete workspace.roster;delete workspace.seasonReset;}
      configuredCups.clear();
     }
    }
    }
   }
   auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
   await finish(response);
   if(restartRequested&&socket===current&&!stopping&&process.connected)process.send?.({type:'restart-request'});
  }catch{log('ADMIN_CONTROL_RETRY');if(finish)await finish('⚠️ A central não confirmou este comando no banco. Use !central para conferir a situação antes de repetir.').catch(()=>{});else if(socket===current&&!stopping)await sendBotMessage(current,group,{text:'⚠️ A central não confirmou este comando no banco. Use !central para conferir a situação antes de repetir.'}).catch(()=>{});}
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
  if(auth.data.cupInbox.length>=100){await sendBotMessage(current,group,{text:'⚠️ Muitas consultas aguardando. Tente !meujogo novamente em instantes.'});return;}
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
  if(socket===current&&!stopping&&enabled('minicamp')&&inChannel(group,'minicamp'))await sendBotMessage(current,group,{text:answer});return;
 }
 if(/^!(?:modelos|ativarmodelo)(?:\s|$)/i.test(text)&&inChannel(group,'minicamp')){
  if(!enabled('minicamp')||!cupApi||!message.key.participant)return;
  const dedup=JSON.stringify([group,message.key.participant,id]);if(auth.data.seen.includes(dedup))return;
  const aliases=await cupAliases(message.key.participant,current);
  await configureCup(group,current);
  const response=await cupApi<{text:string}>({action:'admin-templates',event:{group,aliases,text:text.trim()}});
  auth.data.seen.push(dedup);auth.data.seen=auth.data.seen.slice(-1000);await auth.save();
  if(socket===current&&!stopping&&enabled('minicamp')&&inChannel(group,'minicamp'))await sendBotMessage(current,group,{text:response.text});return;
 }
 if(cupApi&&minicampCommand(text.trim())){
  if(!enabled('minicamp'))return;
  if(!inChannel(group,'minicamp')||!message.key.participant||text.length>1000)return;
  const aliases=await cupAliases(message.key.participant,current);
  if(/^!config(?:\s|$)/i.test(text.trim())){
   await configureCup(group,current);
   const answer=await cupApi<{text:string|null}>({action:'config',event:{group,aliases,id,name:message.pushName??'ADM',text}});
   if(answer.text&&socket===current&&enabled())await sendBotMessage(current,group,{text:answer.text});return;
  }
  if(/^!sorteio\s+/i.test(text.trim())){
   const mentioned=context?.mentionedJid??[];
   const reason=text.includes('|')?text.slice(text.lastIndexOf('|')+1).trim():'Nova seleção solicitada pelo ADM';
   const name=text.trim().replace(/^!sorteio\s+/i,'').split('|')[0]!.trim().replace(/^@+/,'').trim();
   let answer='Use !sorteio Samuel ou !sorteio @pessoa [| motivo]. Informe o nome salvo na Copa ou marque uma conta; a chave e os placares ficam como estão.';
   if(mentioned.length<=1&&name.length>=2&&name.length<=60&&reason.length>=8&&reason.length<=160){
    let valid=true;
    if(mentioned.length){
     const metadata=await current.groupMetadata(group);
     valid=metadata.participants.some(p=>jidNormalizedUser(p.id)===jidNormalizedUser(mentioned[0]!));
    }
    if(valid){
     await configureCup(group,current);
     try{
      const target=mentioned.length?{targetAliases:await cupAliases(mentioned[0]!,current)}:{targetName:name};
      const result=await cupApi<{error?:string;changed?:boolean;duplicate?:boolean}>({action:'cup-reroll-team',group,aliases,...target,messageId:id,reason});
      answer=result.error?'⚠️ '+result.error:result.changed?'🎲 Sorteio registrado. O novo time e a chave serão anunciados aqui em instantes.':'✅ Pedido já processado. Confira !sorteio.';
     }catch{answer='⚠️ Não foi possível registrar a troca agora. Tente novamente; a mesma mensagem não gera dois sorteios.';}
    }else answer='⚠️ Marque uma pessoa que esteja neste grupo da Copa.';
   }
   if(socket===current&&!stopping&&enabled('minicamp'))await sendBotMessage(current,group,{text:answer});return;
  }
  auth.data.cupInbox??=[];
  if(!auth.data.cupInbox.some(e=>e.group===group&&e.id===id&&e.aliases.some(a=>aliases.includes(a)))){
   if(auth.data.cupInbox.length>=100){
    log('MINICAMP_QUEUE_FULL');
    if(socket===current&&enabled('minicamp'))try{await sendBotMessage(current,group,{text:'⚠️ O Minicamp está com muitas solicitações aguardando. Este comando não foi registrado; tente novamente em instantes.'});}catch{log('MINICAMP_QUEUE_NOTICE_FAILED');}
    return;
   }
   let targets=/^!(?:confronto|carreira|jornada|registrar|associar|cadastrar|editar|excluir|stats|titulo|título)\s/i.test(text)&&context?.mentionedJid?.length&&context.mentionedJid.length<=2?await Promise.all(context.mentionedJid.map(j=>cupAliases(j,current))):undefined;
   if(targets?.length&&/^!(?:registrar|associar|cadastrar|editar|excluir)\s/i.test(text)){
    const metadata=await current.groupMetadata(group);
    const members=new Set(metadata.participants.map(p=>jidNormalizedUser(p.id)));
    if(!context?.mentionedJid?.every(j=>members.has(jidNormalizedUser(j))))targets=undefined;
   }
   if(/^!sincronizarcontas\s*$/i.test(text)){
    const metadata=await current.groupMetadata(group);
    targets=await Promise.all(metadata.participants.slice(0,100).map(p=>cupAliases(p.id,current)));
   }
  auth.data.cupInbox.push({group,aliases,targets,id,name:message.pushName??'Participante',text:text.trim(),at:eventAt});await auth.save();
  if(/^!resultado(?:\s|$)/i.test(text.trim())&&message.key.participant){
   auth.data.scoreReactions??=[];
   auth.data.scoreReactions.push({group,participant:message.key.participant,id,at:Date.now()});
   auth.data.scoreReactions=auth.data.scoreReactions.slice(-100);
   await auth.save();
  }
  }
  void cupTick();return;
 }
 if(!enabled('resenha')||!inChannel(group,'resenha'))return;
 const request=/^!palpite(?:\s|$)/i.test(text)?text.replace(/^!palpite\s*/i,'')+' quem ganha':/^!tecnicos\s*$/i.test(text)?'__LIST_COACHES__':banterRequest(text,Boolean(mention),Boolean(reply));if(request===null)return;
 if(cupApi&&message.key.participant&&!text.trim().startsWith('!')){
  const checked=await cupApi<{blocked:boolean}>({action:'block-check',aliases:await cupAliases(message.key.participant,current)});
  if(checked.blocked)return;
 }
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
 if(socket===current&&!stopping&&inChannel(group,'resenha')&&enabled('resenha')){await sendBotMessage(current,group,{text:response});log('RESENHA_SENT');}
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
  for(const event of pendingCupBatch(auth.data.cupInbox??[],group=>inChannel(group,'minicamp'))){
   if(!enabled('minicamp'))break;
   if(!inChannel(event.group,'minicamp'))continue;
   await configureCup(event.group,current);await cupApi({action:'event',event});
   auth.data.cupInbox=auth.data.cupInbox!.filter(e=>e!==event);await auth.save();
  }
  const batch=await cupApi<{messages:{id:string;group_id:string;body:string;wa_message_id:string;lease:string;mentions?:string[]}[]}>({action:'poll'});
  for(const m of batch.messages){
   if(!inChannel(m.group_id,'minicamp')||socket!==current||stopping||!enabled('minicamp')){await cupApi({action:'ack',id:m.id,lease:m.lease,sent:false});continue;}
   let sent=false;
   try{
    const requested=(m.mentions??[]).filter(j=>/^[0-9]+@s\.whatsapp\.net$/.test(j)).slice(0,32);
    const participants=requested.length?(await current.groupMetadata(m.group_id)).participants:[];
    const aliases=await Promise.all(participants.map(p=>cupAliases(p.id,current).catch(():string[]=>[])));
    const mentions=requested.filter(j=>aliases.some(groupMember=>groupMember.includes(j)));
    const body=mentions.length?m.body+'\n\n📣 '+(m.body.startsWith('🎲 SORTEIO · ')||m.body.startsWith('🎲 CONFRONTOS · ')?'@todos · ':'')+mentions.map(j=>'@'+j.split('@')[0]).join(' '):m.body;
    const loaned=auth.data.loanGroups?.includes(m.group_id)===true;
    const groupPicture=guestAnnouncementImage(m.body,loaned,auth.data.controlRooms?.[m.group_id]?.guestImage);
    const card=loaned?null:cupMediaFor(m.body);
    if(groupPicture){
     try{
      const url=await current.profilePictureUrl(m.group_id,'image');
      if(!url)throw Error('Group picture unavailable');
      await sendBotMessage(current,m.group_id,{image:{url},caption:body,mentions},{messageId:m.wa_message_id});sent=true;
     }catch{log('GUEST_IMAGE_FALLBACK');}
    }
    if(!sent&&card){
     try{
      const path=card==='sorteio'?'../assets/mlg-sorteio.jpg':card==='campeao'?'../assets/mlg-campeao.jpg':card==='classificacao'?'../assets/mlg-classificacao.jpg':card==='proxima-copa'?'../assets/mlg-proxima-copa.jpg':'../assets/mlg-partida.jpg';
      await sendBotMessage(current,m.group_id,{image:await readFile(new URL(path,import.meta.url)),caption:body,mentions},{messageId:m.wa_message_id});sent=true;
     }catch{log('MINICAMP_IMAGE_FALLBACK');}
    }
    if(!sent){await sendBotMessage(current,m.group_id,{text:body,mentions},{messageId:m.wa_message_id});sent=true;}
   }catch{log('MINICAMP_SEND_RETRY');}
   await cupApi({action:'ack',id:m.id,lease:m.lease,sent});
  }
  for(const entry of (auth.data.scoreReactions??[]).slice(0,10)){
   if(Date.now()-entry.at>24*60*60*1000){auth.data.scoreReactions=auth.data.scoreReactions?.filter(e=>e!==entry);await auth.save();continue;}
   if(!inChannel(entry.group,'minicamp'))continue;
   const state=await cupApi<{status:'processing'|'pending'|'confirmed'|'rejected'}>({action:'score-reaction',group:entry.group,messageId:entry.id});
   if(state.status!=='confirmed'&&state.status!=='rejected')continue;
   try{
    await sendBotMessage(current,entry.group,{react:{text:state.status==='confirmed'?'✅':'❌',key:{remoteJid:entry.group,participant:entry.participant,id:entry.id,fromMe:false}}});
    auth.data.scoreReactions=auth.data.scoreReactions?.filter(e=>e!==entry);await auth.save();
   }catch{log('SCORE_REACTION_RETRY');}
  }
  cupHealthy=true;lastCupTick=lastCupSuccessAt=Date.now();
 }catch{cupHealthy=false;log('MINICAMP_RETRY');}finally{
  cupBusy=false;
  // Drain persisted requests promptly after recovery without overlapping workers.
  if(!stopping&&cupHealthy&&auth.data.cupInbox?.some(e=>inChannel(e.group,'minicamp')))setTimeout(()=>{void cupTick();},250);
 }
}
const controls=createServer(client=>{let buffer='';client.setTimeout(45000,()=>client.destroy());client.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>8192){client.destroy();return;}if(!buffer.includes('\n'))return;client.pause();void(async()=>{
 const req=JSON.parse(buffer.trim());

 if(['loan-status','loan-configure','guest-control'].includes(req.action)){
  if(!cupApi||!socket||phase!=='CONNECTED'||!auth.data.groups.includes(req.group)||!/^([0-9a-f-]{36})$/i.test(req.platformActor??''))throw Error('Loan controls unavailable');
  const metadata=await socket.groupMetadata(req.group);
  if(req.action==='loan-configure'){
   if(!['grant','revoke'].includes(req.operation))throw Error('Invalid operation');
   const person=metadata.participants.find(p=>p.id===req.admin);
   if(req.operation==='grant'&&(!person?.admin||!metadata.participants.some(p=>p.admin&&[socket!.user?.id,socket!.user?.lid].some(id=>id&&id.replace(/:[0-9]+(?=@)/,'')===p.id.replace(/:[0-9]+(?=@)/,'')))))throw Error('Organizer and bot must be group admins');
   await configureCup(req.group,socket);
   const result=await cupApi<Record<string,any>>({action:'platform-loan',group:req.group,platformActor:req.platformActor,operation:req.operation,targetAliases:person?await cupAliases(person.id,socket):undefined,name:'Organizador convidado'});
   if(result.error)throw Error(result.error);
   auth.data.loanGroups??=[];
   if(req.operation==='grant'){auth.data.loanJoinPending??=[];if(!auth.data.loanJoinPending.includes(req.group))auth.data.loanJoinPending.push(req.group);if(!auth.data.loanGroups.includes(req.group))auth.data.loanGroups.push(req.group);auth.data.groupModes??={};auth.data.groupModes[req.group]='minicamp';}
   else{auth.data.loanGroups=auth.data.loanGroups.filter(g=>g!==req.group);delete auth.data.controlRooms?.[req.group];}
   await auth.save();void loanJoinTick();return result;
  }
  const status=await cupApi<Record<string,any>>({action:'platform-loan',group:req.group,platformActor:req.platformActor,operation:'get'});
  if(status.error)throw Error(status.error);
  if(req.action==='loan-status'){delete status.aliases;return {...status,draft:auth.data.controlRooms?.[req.group]?.guestDraft??null};}
  if(!status.loan?.active||!Array.isArray(status.aliases)||!status.aliases.length||typeof req.text!=='string'||req.text.length>16000)throw Error('Invalid guest command');
  const cmd=req.text.trim().split(/\s/)[0].toLowerCase();
  const setup=['!painel','!central','!pendencias','!novacopa','!nome','!modalidade','!formato','!vagas','!jogos','!classificados','!equipes','!times','!adicionar','!remover','!corrigirclubes','!revisar','!abrircopa','!descartar','!cancelarcopa','!imagemgrupo','!imagemtexto','!daradm','!tiraradm','!adms'];
  const play=['!copa','!tabela','!proximafase','!jogo','!campeoes','!historico','!forcarresultado'];
  if(!setup.includes(cmd)&&!play.includes(cmd))throw Error('Unsupported guest command');
  if(play.includes(cmd))return cupApi({action:'platform-guest-event',group:req.group,platformActor:req.platformActor,aliases:status.aliases,messageId:'platform-'+crypto.randomUUID(),text:req.text,name:'Organizador'});
  auth.data.controlRooms??={};const room=auth.data.controlRooms[req.group]??={};room.targetId=req.group;auth.data.controlRooms[req.group]=room;
  const resolveGroupAdmin=async(group:string,phone:string)=>{if(group!==req.group)return null;for(const person of metadata.participants){if(!person.admin)continue;const aliases=await cupAliases(person.id,socket!);if(aliases.includes(phone+'@s.whatsapp.net'))return aliases;}return null;};
  const response=await adminControl(req.text,room,[{id:req.group,name:metadata.subject}],async payload=>{if(!['guest-status','guest-open','guest-cancel','guest-admin'].includes(String(payload.action))||payload.group!==req.group)throw Error('Invalid guest action');return cupApi!(payload);},()=>auth.save(),Date.now(),{controlGroup:req.group,aliases:status.aliases,messageId:'platform-'+crypto.randomUUID(),resolveGroupAdmin},auth.data.controlRooms,true);
  return {response,draft:room.guestDraft??null};
 }
 if(req.action==='news-status')return {sourceConfigured:Boolean(loadNews),group:auth.data.newsGroup??null,cursor:auth.data.newsCursor??null,paused:!enabled(),pollIntervalSeconds:60};
 if(req.action==='news-config'){if(newsBusy)throw Error('Journal delivery in progress');if(req.group!==null){if(!socket||phase!=='CONNECTED')throw Error('Bot unavailable');const participating=await socket.groupFetchAllParticipating();if(!Object.hasOwn(participating,req.group))throw Error('Bot is not in journal group');}const result=await configureJournal(auth.data,req.group,loadNews,()=>auth.save());log('NEWS_CONTROLS_UPDATED');return {...result,sourceConfigured:Boolean(loadNews)};}
 if(req.action==='status')return {controls:auth.data.controls??{enabled:true,resenha:true,minicamp:true},queued:auth.data.cupInbox?.length??0,phase,authorizedGroups:auth.data.groups.length,minicamp:cupApi?(cupHealthy?'READY':'RETRYING'):'DISABLED',minicampLastSuccessAt:lastCupSuccessAt||null,newsGroup:auth.data.newsGroup??null,newsConfigured:Boolean(loadNews),marketConfigured:Boolean(marketApi),marketHealthy,marketPaused,marketLastSuccessAt:lastMarketSuccessAt||null,marketQueued:pendingLocalMarketProposals(auth.data).length,marketChannels:marketChannels.length,marketResponsesQueued:auth.data.marketResponses?.length??0,marketOperations:marketOperationsPayload(auth.data,{phase,enabled:enabled(),healthy:marketHealthy,blocked:marketDeliveryBlocked,groups:[]},marketBatches,marketChannels),marketLastTickAt:lastMarketTick||null,checkedAt:Date.now()};
 if(req.action==='select-context'){
  if(typeof req.group!=='string'||!req.group.endsWith('@g.us')||typeof req.templateId!=='string'||req.templateId.length>100)throw Error('Invalid selection');
  if(phase!=='CONNECTED'||!socket)throw Error('Not connected');
  const participating=await socket.groupFetchAllParticipating();if(!Object.hasOwn(participating,req.group))throw Error('Group unavailable');
  const previous=auth.data.panelSelection;const templates={...previous?.templates};
  if(req.templateChanged)templates[req.group]=req.templateId;
  auth.data.panelSelection={group:req.group,templates};
  try{await auth.save();}catch{auth.data.panelSelection=previous;throw Error('Selection persistence failed');}
  return {selectedGroup:req.group,selectedTemplate:templates[req.group]};
 }
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
 if(auth.data.newsGroup===req.group){delete auth.data.newsGroup;}
 auth.data.groups=auth.data.groups.filter(g=>g!==req.group);
 if(auth.data.groupModes)delete auth.data.groupModes[req.group];
 if(auth.data.controlRooms)delete auth.data.controlRooms[req.group];
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
 if(['setadmins','history-candidates','history-review','competition-get','competition-save','templates-list','template-get','template-save','template-activate','template-delete','cup-open','cup-cancel','cup-void'].includes(req.action)){
 const startingControl=req.action==='setadmins'&&req.mode==='controle'&&!auth.data.groups.includes(req.group);
 if(!cupApi||!socket||(!auth.data.groups.includes(req.group)&&!startingControl))throw Error('Group unavailable');
 if(!allowsGroup(auth.data.groupModes,req.group,'minicamp')&&!['setadmins','history-candidates','history-review'].includes(req.action))throw Error('Control group cannot host a Cup');
 await configureCup(req.group,socket);
 if(req.action==='setadmins'){
 if(auth.data.loanGroups?.includes(req.group))throw Error('Use guest administrator controls for a borrowed group');
  const metadata=await socket.groupMetadata(req.group);
  if(!Array.isArray(req.admins)||req.admins.length<1||req.admins.length>10||!req.admins.every((id:string)=>metadata.participants.some(p=>p.id===id)))throw Error('Invalid admins');
  const admins=await Promise.all(req.admins.map((id:string)=>cupAliases(id,socket!)));
  const result=await cupApi<{updated?:boolean;error?:string}>({action:'setadmins',group:req.group,admins,revision:req.revision});
  if(req.mode==='controle'&&result.updated){if(startingControl)auth.data.groups.push(req.group);auth.data.groupModes??={};auth.data.groupModes[req.group]='controle';await auth.save();log(startingControl?'GROUP_AUTHORIZED':'GROUP_MODE_UPDATED');}
  return {...result,authorized:startingControl&&result.updated,mode:groupMode(auth.data.groupModes,req.group)};
 }
 const result=await cupApi<Record<string,unknown>>({action:req.action,group:req.group,ids:req.ids,approved:req.approved,name:req.name,teamKind:req.teamKind,formatSize:req.formatSize,teams:req.teams,templateId:req.templateId,size:req.size,cupId:req.cupId,reason:req.reason});
 return req.action==='templates-list'?{...result,selectedTemplate:auth.data.panelSelection?.templates[req.group]}:result;
 }
 if(req.action==='pair'){
 if((auth.state.creds.registered&&!auth.data.sessionRevoked)||phase==='CONNECTED'||phase==='STOPPED')throw new Error('Pairing unavailable');
 if(!/^\d{10,15}$/.test(req.phone??''))throw new Error('Invalid phone');
 if(timer)clearTimeout(timer);
 if(recoverRevokedSession(auth.data,auth.state,initAuthCreds))await auth.save();
 // A failed code request sets creds.me before registration. Clear only that
 // incomplete login marker on an explicit retry, never a registered session.
 if(!socket){delete auth.state.creds.me;delete auth.state.creds.pairingCode;await auth.save();await connect();}
 const pairingSocket=socket!;log('PAIRING_REQUEST_STARTED');
 try{const code=await requestReadyPairing(pairingSocket,req.phone,pairingReady.has(pairingSocket),()=>socket===pairingSocket&&!stopping);log('PAIRING_CODE_READY');return {code};}
 catch{log('PAIRING_REQUEST_FAILED');return {error:'Não foi possível preparar a conexão com o WhatsApp. Aguarde 60 segundos e tente novamente.',phase};}
 }
 if(phase!=='CONNECTED'||!socket)throw new Error('Not connected');
 if(req.action==='groups')return {groups:Object.values(await socket.groupFetchAllParticipating()).map(g=>({id:g.id,name:g.subject,authorized:auth.data.groups.includes(g.id),mode:groupMode(auth.data.groupModes,g.id),loaned:Boolean(auth.data.loanGroups?.includes(g.id))})),selectedGroup:auth.data.panelSelection?.group??''};
 if(typeof req.group!=='string'||!req.group.endsWith('@g.us'))throw new Error('Invalid group');
 const group=await socket.groupMetadata(req.group);
 if(req.action==='participants'){
 let registered:{aliases:string[];revision:string}={aliases:[],revision:''};
 if(cupApi&&(auth.data.groups.includes(req.group)||req.mode==='controle')){await configureCup(req.group,socket);registered=await cupApi({action:'getadmins',group:req.group});}
 return {revision:registered.revision,participants:await Promise.all(group.participants.map(async p=>{
 const aliases=await cupAliases(p.id,socket!);const phone=aliases.find(a=>a.endsWith('@s.whatsapp.net'))?.split('@')[0];
 return {id:p.id,phone:phone?'+'+phone:p.id,selected:aliases.some(a=>registered.aliases.includes(a)),isAdmin:Boolean(p.admin)};
 }))};}
 if(req.action==='authorize'){
 if(!group.participants.some(p=>p.id===req.admin))throw new Error('Invalid participant');
 if(!auth.data.groups.includes(req.group))auth.data.groups.push(req.group);
 if(!validGroupMode(req.mode))throw Error('Invalid group mode');auth.data.groupModes??={};auth.data.groupModes[req.group]=req.mode;await auth.save();log('GROUP_AUTHORIZED');return {authorized:true,mode:req.mode};
 }throw new Error('Unknown operation');
 })().then(r=>client.end(JSON.stringify(r)+'\n')).catch(()=>client.end(JSON.stringify({error:'Operação recusada. Confira conexão, número e seleção.'})+'\n'));});});
function runtimeReady(){return !stopping&&phase==='CONNECTED'&&(!enabled('minicamp')||!cupApi||(cupHealthy&&Date.now()-lastCupTick<120000))&&(!marketApi||!enabled()||(marketHealthy&&Date.now()-lastMarketTick<120000));}
const health=httpServer((req,res)=>{if(req.url==='/livez'||req.url==='/readyz'){const ok=req.url==='/livez'?!stopping:runtimeReady();res.writeHead(ok?200:503,{'Cache-Control':'no-store'}).end(ok?'OK':'UNAVAILABLE');return;}void portal(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
function fail(event:string){log(event);void shutdown(1);}
async function shutdown(code:number){if(stopping)return;stopping=true;if(cupTimer)clearInterval(cupTimer);if(newsTimer)clearInterval(newsTimer);if(marketTimer)clearInterval(marketTimer);if(localMarketTimer)clearInterval(localMarketTimer);if(timer)clearTimeout(timer);if(stable)clearTimeout(stable);const deadline=setTimeout(()=>process.exit(code),12000);deadline.unref();controls.close();health.close();socket?.end(undefined);await queue;while(cupBusy||newsBusy||marketBusy||loanJoinBusy)await new Promise(r=>setTimeout(r,50));await auth?.flush();key.fill(0);process.exit(code);}
process.on('SIGTERM',()=>{void shutdown(0);});process.on('SIGINT',()=>{void shutdown(0);});process.on('uncaughtException',()=>fail('UNCAUGHT_ERROR'));process.on('unhandledRejection',()=>fail('UNHANDLED_REJECTION'));
async function main(){log('MARKET_BRIDGE_DISABLED_BOT_LOCAL_TRANSFER');auth=await vaultAuth(endpoint!,token!,key);marketChannels=auth.data.groups.filter(g=>['transfer','trade'].includes(groupMode(auth.data.groupModes,g))).map(g=>({group:g,kind:groupMode(auth.data.groupModes,g) as 'transfer'|'trade'}));marketCaptureSince=auth.data.marketWindow?.captureSince??0;auth.data.replyHistory??={};auth.data.marketFinance??=structuredClone(INITIAL_MARKET_FINANCE);auth.data.cupInbox??=[];auth.data.marketInbox??=[];for(const event of auth.data.marketInbox)event.queuedAt??=Date.now();ensureLocalMarketTicketIds(auth.data);auth.data.marketResponses??=[];if(marketApi){await marketTick();marketTimer=setInterval(()=>{void marketTick();},15000);}localMarketTimer=setInterval(()=>{void localMarketAuditTick();},15000);if(cupApi){try{await cupApi({action:'health'});cupHealthy=true;}catch{cupHealthy=false;log('MINICAMP_RETRY');}cupTimer=setInterval(()=>{void cupTick();void loanJoinTick();},15000);}if(loadNews)newsTimer=setInterval(()=>{void newsTick();},60000);banterReply=createBanterReply(auth.data.replyHistory);await auth.save();await unlink(controlPath).catch(()=>undefined);controls.listen(controlPath,()=>{void chmod(controlPath,0o600).catch(()=>fail('CONTROL_PERMISSIONS_FAILED'));});if(!process.send)health.listen(Number(process.env.PORT??3000),'0.0.0.0');if(auth.state.creds.registered&&!auth.data.sessionRevoked)await connect();else {phase='NEEDS_PAIRING';log(phase);}}
async function newsTick(){
 if(!loadNews||newsBusy||stopping||phase!=='CONNECTED'||!socket||!enabled()||!auth.data.newsGroup)return;
 newsBusy=true;const current=socket,group=auth.data.newsGroup;
 try{
  if(!auth.data.groups.includes(group)||auth.data.loanGroups?.includes(group))return;
  if(!auth.data.newsCursor){const latest=(await loadNews())[0];auth.data.newsCursor=latest?newsCursor(latest):{publishedAt:new Date().toISOString(),id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};await auth.save();return;}
  for(const article of await loadNews(auth.data.newsCursor)){
   if(socket!==current||stopping||!enabled()||auth.data.newsGroup!==group||!auth.data.groups.includes(group)||auth.data.loanGroups?.includes(group))break;
   if(!newerNews(article,auth.data.newsCursor))continue;
   await sendBotMessage(current,group,{text:newsMessage(article)},{messageId:'MLGNEWS'+article.id.replaceAll('-','').toUpperCase()});
   auth.data.newsCursor=newsCursor(article);await auth.save();
  }
 }catch{log('NEWS_DELIVERY_RETRY');}finally{newsBusy=false;}
}
// Parent owns HTTP while this process owns the WhatsApp session and queues.
if(process.send){
 const pulse=setInterval(()=>{if(process.connected)process.send?.({type:'health',phase,ready:runtimeReady()});},2000);
 pulse.unref();process.on('disconnect',()=>{void shutdown(0);});
}
void main().catch(()=>fail('SESSION_STORAGE_UNAVAILABLE'));

async function marketTick(){
 if(!marketApi||marketBusy||stopping)return;
 marketBusy=true;lastMarketTick=Date.now();
 try{
  const config=await marketApi<{channels:MarketChannel[];batches:MarketBatch[];safety:{paused:boolean};captureSince:string;rosterCollection?:RosterConfig}>('config',{rosterVersion:1});
  if(!Array.isArray(config.channels)||!Array.isArray(config.batches))throw Error('Invalid market configuration');
  rosterCaptureEnabled=Boolean(config.rosterCollection?.enabled&&!config.rosterCollection.opened&&config.rosterCollection.run);
  marketChannels=config.channels.filter(c=>groupMode(auth.data.groupModes,c.group)!=='market-loan');
  marketBatches=config.batches.filter(b=>typeof b.group==='string'&&Number.isFinite(b.count)&&Number.isFinite(b.batch)).map(b=>({...b,limit:Number.isFinite(b.limit)?b.limit:10,botLocked:Boolean(b.botLocked)}));
  marketSafetySupported=typeof config.safety?.paused==='boolean';marketPaused=config.safety?.paused===true;marketCaptureSince=auth.data.marketWindow?.captureSince??0;marketDeliveryBlocked=(config.batches??[]).some(b=>b.count>=(b.limit??10));
  if(phase!=='CONNECTED'||!socket||!enabled())return;
  const current=socket;
  let gateHealthy=true;
  const syncGates=async(batches:MarketBatch[])=>{for(const batch of batches){
   try{
   if(!marketChannels.some(c=>c.group===batch.group)||!auth.data.groups.includes(batch.group)||auth.data.loanGroups?.includes(batch.group))continue;
   const metadata=await current.groupMetadata(batch.group);
   const closed=await reconcileMarketGroupGate(batch,Boolean(metadata.announce),()=>current.groupSettingUpdate(batch.group,'announcement'),async locked=>{await marketApi!('gate_ack',{group:batch.group,locked});});
   if(closed)await sendBotMessage(current,batch.group,{text:`🔒 ${batch.limit??10} propostas recebidas. Os ADMs conferem a remessa e liberam a próxima pela plataforma; depois reabrem o grupo manualmente. O bot não reabre o grupo.`});
   }catch{gateHealthy=false;log('MARKET_GROUP_GATE_RETRY');}
  }};
  await syncGates(Array.isArray(config.batches)?config.batches:[]);
  // Save captured events before any remote acknowledgement or queue removal.
  if(auth.data.marketInbox?.length||auth.data.marketResponses?.length)await auth.save();
  const hadMarketInbox=Boolean(auth.data.marketInbox?.length);
  await drainMarketInbox(auth.data,marketApi,()=>auth.save());
  if(hadMarketInbox){
   const updated=await marketApi<{batches:MarketBatch[]}>('config',{rosterVersion:1});
   if(!Array.isArray(updated.batches))throw Error('Invalid market batches');
   marketDeliveryBlocked=updated.batches.some(b=>b.count>=(b.limit??10));
   await syncGates(updated.batches);
  }
  for(const response of [...(auth.data.marketResponses??[])].slice(0,20)){
   const result=await marketApi<{success:boolean}>('response',response);if(!result.success)throw Error('Response not confirmed');
   const previous=auth.data.marketResponses;auth.data.marketResponses=auth.data.marketResponses?.filter(e=>!(e.group===response.group&&e.messageId===response.messageId));
   try{await auth.save();}catch(error){auth.data.marketResponses=previous;throw error;}
  }

  await deliverMarketReactions(marketApi,async r=>{
   if(!auth.data.groups.includes(r.group)||auth.data.loanGroups?.includes(r.group))throw Error('Market reaction group is not authorized');
   await sendBotMessage(current,r.group,{react:{text:r.emoji,key:{remoteJid:r.group,participant:r.participant,id:r.messageId,fromMe:false}}});
  },()=>socket===current&&!stopping&&enabled());
  const {notices}=await marketApi<{notices:MarketPrivateNotice[]}>('claim_private');
  if(!Array.isArray(notices))throw Error('Invalid private notice list');
  for(const notice of notices){
   let sent=false;
   if(socket===current&&!stopping&&enabled()&&/^[0-9]+@(s\.whatsapp\.net|lid)$/.test(notice.recipient))
    try{await sendBotMessage(current,notice.recipient,{text:notice.body},{messageId:marketNoticeMessageId('private',notice.id)});sent=true;}catch{log('MARKET_PRIVATE_NOTICE_RETRY');}
   await marketApi('ack_private',{id:notice.id,lease:notice.lease,sent});
  }
  const adminGroups=marketAdminGroups(auth.data.groups,auth.data.groupModes,auth.data.loanGroups,config.rosterCollection?.group);
  for(const answer of [...(auth.data.surveyAnswers??[])].slice(0,20)){
   const result=await marketApi<{success:boolean}>('survey_answer',answer);if(!result.success)throw Error('Survey answer not confirmed');
   const previous=auth.data.surveyAnswers;auth.data.surveyAnswers=previous?.filter(e=>e!==answer);try{await auth.save();}catch(error){auth.data.surveyAnswers=previous;throw error;}
  }
  const survey=await marketApi<{notices:MarketPrivateNotice[]}>('survey_claim',{groups:adminGroups});
  for(const notice of survey.notices??[]){let sent=false;
   const allowed=/^[0-9]+@(s[.]whatsapp[.]net|lid)$/.test(notice.recipient)||adminGroups.includes(notice.recipient);
   if(socket===current&&!stopping&&enabled()&&allowed)try{const result=await sendBotMessage(current,notice.recipient,{text:notice.body},{messageId:rosterMessageId(notice.id,notice.recipient,'survey')});sent=Boolean(result?.key.id);}catch{log('CONFIDENCE_SURVEY_RETRY');}
   await marketApi('survey_ack',{id:notice.id,lease:notice.lease,sent});
  }
  if(config.rosterCollection?.enabled&&config.rosterCollection.group){
   try{
    const participating=await current.groupFetchAllParticipating();
    if(!Object.hasOwn(participating,config.rosterCollection.group))throw Error('Roster destination unavailable');
    await rosterTick(auth.data,config.rosterCollection,()=>auth.save(),async(recipient,text,id)=>{if(socket!==current||phase!=='CONNECTED'||stopping||!enabled())throw Error('Disconnected');const sent=await sendBotMessage(current,recipient,{text},{messageId:id});if(!sent?.key.id)throw Error('Send unconfirmed');},async(entry,dest,id)=>{
     const stream=await downloadContentFromMessage(entry.image,'image');const chunks:Buffer[]=[];let size=0;
     for await(const chunk of stream){size+=chunk.length;if(size>8*1024*1024)throw Error('Image too large');chunks.push(Buffer.from(chunk));}
     const sent=await sendBotMessage(current,dest,{image:Buffer.concat(chunks),caption:'Elenco final — '+entry.name},{messageId:id});if(!sent?.key.id)throw Error('Photo not confirmed');
    },async(entry,status)=>{const result=await marketApi('roster_progress',{run:auth.data.rosterCollection!.run,club:entry.club,status});if(result.success!==true)throw Error('Progress not confirmed');},adminGroups);
   }catch{log('ROSTER_COLLECTION_RETRY');}
  }

  if(adminGroups.length){
   const {notices:adminNotices}=await marketApi<{notices:{id:string;lease:string;group:string;body:string}[]}>('claim_admin',{groups:adminGroups});
   for(const notice of adminNotices??[]){let sent=false;
    if(adminGroups.includes(notice.group)&&socket===current&&!stopping&&enabled())try{await sendBotMessage(current,notice.group,{text:notice.body},{messageId:marketNoticeMessageId('admin',notice.id)});sent=true;}catch{log('MARKET_ADMIN_NOTICE_RETRY');}
    await marketApi('ack_admin',{id:notice.id,lease:notice.lease,sent});
   }
  }
  if(marketSafetySupported&&adminGroups.length){
   const result=await marketApi<{notices:{id:string;lease:string;group:string;body:string}[]}>('claim_health',{groups:adminGroups});
   for(const notice of result.notices??[]){let sent=false;if(adminGroups.includes(notice.group)&&socket===current&&!stopping&&enabled())try{await sendBotMessage(current,notice.group,{text:notice.body},{messageId:'MLGHEALTH'+notice.id.replaceAll('-','').toUpperCase()});sent=true;}catch{}
    await marketApi('ack_health',{id:notice.id,lease:notice.lease,sent});}
  }
  marketHealthy=gateHealthy;if(gateHealthy)lastMarketSuccessAt=Date.now();
 }catch{marketHealthy=false;log('MARKET_BRIDGE_RETRY');}finally{
  try{if(marketApi){const groups=auth.data.groups.filter(g=>groupMode(auth.data.groupModes,g)==='controle'&&!auth.data.loanGroups?.includes(g));await marketApi('heartbeat',marketHealthPayload(auth.data,{phase,enabled:enabled(),healthy:marketHealthy,blocked:marketDeliveryBlocked,groups}));}}catch{log('MARKET_HEALTH_RETRY');}
  marketBusy=false;}
}

let loanJoinBusy=false;
async function loanJoinTick(){
 if(loanJoinBusy||!cupApi||!socket||phase!=='CONNECTED'||stopping)return;
 loanJoinBusy=true;const current=socket;
 try{for(const group of loanJoinBatch(auth.data.loanJoinPending??[],10)){
  try{
  if(socket!==current||stopping)break;
  if(auth.data.groups.includes(group)&&!auth.data.loanGroups?.includes(group)){auth.data.loanJoinPending=auth.data.loanJoinPending?.filter(g=>g!==group);await auth.save();continue;}
  const metadata=await current.groupMetadata(group);
  if(metadata.isCommunity||metadata.isCommunityAnnounce){auth.data.loanJoinPending=auth.data.loanJoinPending?.filter(g=>g!==group);await auth.save();continue;}
  const botAdmin=metadata.participants.some(p=>p.admin&&[current.user?.id,current.user?.lid].some(id=>id&&id.replace(/:[0-9]+(?=@)/,'')===p.id.replace(/:[0-9]+(?=@)/,'')));
  if(!botAdmin)continue;
  const candidates=(await Promise.all(metadata.participants.filter(p=>Boolean(p.admin)).map(p=>cupAliases(p.id,current)))).flat();
  const candidate=await cupApi<{eligible:boolean;manager?:string;name?:string;grantedAt?:number;aliases?:string[]}>({action:'loan-join-check',group,candidates});
  if(!candidate.eligible||!candidate.manager||!candidate.aliases?.length||!candidate.grantedAt){auth.data.loanJoinPending=auth.data.loanJoinPending?.filter(g=>g!==group);await auth.save();continue;}
  if(auth.data.loanWelcomed?.[group]!==candidate.grantedAt){
   const claim=await cupApi<{claimed?:boolean;error?:string}>({action:'loan-claim',group,aliases:candidate.aliases,name:candidate.name});
   if(!claim.claimed){auth.data.loanJoinPending=auth.data.loanJoinPending?.filter(g=>g!==group);await auth.save();continue;}
   if(!auth.data.groups.includes(group))auth.data.groups.push(group);auth.data.loanGroups??=[];if(!auth.data.loanGroups.includes(group))auth.data.loanGroups.push(group);
   auth.data.groupModes??={};auth.data.groupModes[group]='minicamp';auth.data.controlRooms??={};
   const room=auth.data.controlRooms[group]??auth.data.controlRooms['loan-private:'+candidate.manager]??{};room.targetId=group;room.guestInvitationAt=candidate.grantedAt;auth.data.controlRooms[group]=room;await auth.save();
   const recipient=candidate.aliases.find(j=>j.endsWith('@s.whatsapp.net'))??candidate.aliases[0]!;
   const sent=await sendBotMessage(current,recipient,{text:'🤝 Entrei no grupo '+metadata.subject+'. Seu empréstimo foi ativado. Configure aqui no privado com !configbot: vou fazer poucas perguntas e mostrar tudo para você confirmar ou rejeitar. Depois use !alterarconfig para alterar uma opção. Só após a configuração confirmada, envie !novacopa no grupo para abrir inscrições.'});
   if(!sent?.key.id)throw Error('Welcome not confirmed');auth.data.loanWelcomed??={};auth.data.loanWelcomed[group]=candidate.grantedAt;
  }
  auth.data.loanJoinPending=auth.data.loanJoinPending?.filter(g=>g!==group);await auth.save();
  }catch{log('LOAN_JOIN_RETRY');}
 }}finally{loanJoinBusy=false;}
}
