import test from 'node:test';import assert from 'node:assert/strict';
import {marketBridge,marketEvent,enqueueMarketEvent,enqueueMarketResponse,drainMarketInbox,drainMarketResponses,deliverMarketReactions,canRecoverMarketMessage,marketHealthPayload,MAX_MARKET_PROPOSALS,MAX_MARKET_RESPONSES,type MarketApi,type MarketEvent} from '../src/infra/platform-market.ts';
import type {MarketResponse} from '../src/infra/market-response.ts';
const text='💰 PROPOSTA DE COMPRA\nClube de origem: Manchester City\nJogador: Mateus Nunes\nClube de destino: Galatasaray\nValor da transferência: €5 milhões';
const event=marketEvent('12345@g.us','MESSAGE','123456789@s.whatsapp.net',text,[{kind:'transfer',group:'12345@g.us'}])!;
test('reconnect history recovers only configured market messages from the current cycle',()=>{
 const since=1700000000000,now=since+60000,channels=[{group:event.group,kind:'transfer' as const}];
 assert.equal(canRecoverMarketMessage('append',event.group,since/1000,since,channels,now),true);
 assert.equal(canRecoverMarketMessage('append',event.group,(since-1000)/1000,since,channels,now),false);
 assert.equal(canRecoverMarketMessage('append','other@g.us',since/1000,since,channels,now),false);
 assert.equal(canRecoverMarketMessage('append',event.group,'invalid',since,channels,now),false);
 assert.equal(canRecoverMarketMessage('append',event.group,since/1000,0,channels,now),false);
});
test('restart after remote acknowledgement but before local save retries the same durable proposal once',async()=>{
 const persisted={marketInbox:[event]},stored=new Set<string>();let effects=0;
 const api=(async(_action:string,payload:any)=>{if(!stored.has(payload.messageId)){stored.add(payload.messageId);effects++;}return {success:true};}) as any;
 await assert.rejects(drainMarketInbox(persisted,api,async()=>{throw Error('disk unavailable');}));
 const restarted=JSON.parse(JSON.stringify(persisted));await drainMarketInbox(restarted,api,async()=>{},async()=>true);
 assert.equal(effects,1);assert.equal(restarted.marketInbox.length,0);
});
test('health signal records backlog age without message contents or personal numbers',()=>{
 const signal=marketHealthPayload({marketInbox:[{...event,queuedAt:1000}],marketResponses:[{at:500}]},{phase:'CONNECTED',enabled:true,healthy:true,blocked:false,groups:['12345@g.us'],now:601000});
 assert.equal(signal.oldestAgeSeconds,600);assert.equal(signal.proposalQueue,1);assert.equal(signal.responseQueue,1);assert.ok(!JSON.stringify(signal).includes(event.text));assert.ok(!JSON.stringify(signal).includes(event.participant));
});
test('capture only configured groups and flag a wrong template',()=>{assert.equal(marketEvent('other@g.us','id','123@lid',text,[{kind:'transfer',group:'12345@g.us'}]),null);assert.equal(event.parsed.amountEuros,'5000000');assert.ok(marketEvent('12345@g.us','id','123@lid',text,[{kind:'trade',group:'12345@g.us'}])!.parsed.issues.length);});
test('bridge sends token only to configured TLS Supabase endpoint',async()=>{let request:any;const api=marketBridge('https://fixture.supabase.co','public','a'.repeat(64),async(url,options)=>{request={url:String(url),options};return new Response('{"success":true}',{status:200});});await api('ingest',event);assert.equal(request.url,'https://fixture.supabase.co/rest/v1/rpc/bot_whatsapp_market_gate');assert.equal(JSON.parse(request.options.body).p_payload.messageId,'MESSAGE');assert.throws(()=>marketBridge('https://malicious.invalid','key','a'.repeat(64)));});
test('failed ingestion is deferred; failed persistence preserves the proposal for retry',async()=>{const state={marketInbox:[event]};await drainMarketInbox(state,(async()=>{throw Error('offline');}) as any,async()=>{},async()=>true,1000);assert.equal(state.marketInbox.length,1);assert.equal(state.marketInbox[0]?.attempts,1);assert.equal(state.marketInbox[0]?.retryAt,16000);await assert.rejects(drainMarketInbox(state,(async()=>({success:true})) as any,async()=>{throw Error('vault failed');},async()=>true,16000));assert.equal(state.marketInbox.length,1);await drainMarketInbox(state,(async()=>({success:true})) as any,async()=>{},async()=>true,16000);assert.equal(state.marketInbox.length,0);});
test('reaction transport targets original message and ack failure never reruns financial operation',async()=>{const calls:any[]=[];const reaction={id:'uuid',revision:2,emoji:'🟢',lease:'lease',group:event.group,messageId:event.messageId,participant:event.participant};const api=(async(action:string,payload:any)=>{calls.push({action,payload});return action==='claim_reactions'?{reactions:[reaction]}:{success:true};}) as any;await deliverMarketReactions(api,async value=>assert.equal(value.messageId,'MESSAGE'),()=>true);assert.deepEqual(calls.map(c=>c.action),['claim_reactions','ack_reaction']);assert.equal(calls[1].payload.sent,true);calls.length=0;await deliverMarketReactions(api,async()=>{throw Error('WhatsApp offline');},()=>true);assert.equal(calls[1].payload.sent,false);});

test('admin and member submissions use the same batch path; notices and examples are ignored',()=>{
 const channels=[{kind:'transfer' as const,group:'12345@g.us'}];
 for(const participant of ['111@lid','222@lid'])assert.ok(marketEvent('12345@g.us','id',participant,text,channels));
 for(const notice of ['A proposta de compra deve ter os clubes e o jogador.','Esse jogador não está disponível na liga.','Ele ainda não confirmou.', 'MODELO DE EXEMPLO\n'+text,'EXEMPLO\n'+text,text.replace('Manchester City','[clube de origem]')])assert.equal(marketEvent('12345@g.us','id','111@lid',notice,channels),null);
 assert.ok(marketEvent('12345@g.us','id','111@lid',text.replace('PROPOSTA DE COMPRA','MÓDULO DE COMPRA'),channels));
});
test('closed batch is retained only until its rejection notice is delivered',async()=>{
 const state={marketInbox:[event]};let saved=0,notices=0,ingestions=0;
 const api=(async()=>{ingestions++;return {success:false,reason:'batch_closed'};}) as any;
 await drainMarketInbox(state,api,async()=>{saved++;},async()=>{notices++;return false;},1000);
 assert.equal(state.marketInbox.length,1);assert.equal(saved,2);assert.equal(notices,1);assert.equal(ingestions,1);
 assert.equal(state.marketInbox[0]?.terminalReason,'batch_closed');
 await drainMarketInbox(state,api,async()=>{saved++;},async()=>{notices++;return true;},16000);
 assert.equal(state.marketInbox.length,0);assert.equal(notices,2);assert.equal(ingestions,1);
});
test('explicit external and internal purchases are distinct; conflicting labels need review',()=>{
 const channels=[{kind:'transfer' as const,group:'12345@g.us'}];
 const parse=(s:string)=>marketEvent('12345@g.us','m','123@lid',s,channels)!.parsed;
 assert.equal(parse(text.replace('Manchester City','Externo')).purchaseScope,'external');
 assert.equal(parse(text+'\nTipo de compra: interna').purchaseScope,'internal');
 assert.equal(parse(text+'\nTipo de compra: externa').purchaseScope,'external');
 assert.equal(parse(text).purchaseScope,'review');
 const bad=parse(text.replace('Manchester City','Externo')+'\nTipo de compra: interna');assert.equal(bad.purchaseScope,'review');assert.ok(bad.issues.length);
});

function queueProposal(messageId:string):MarketEvent{return {...event,messageId,text:'Proposal '+messageId};}
function queueResponse(messageId:string):MarketResponse{return {group:event.group,messageId,participant:event.participant,proposalMessageId:event.messageId,decision:'positive',text:'Confirmo',at:1000};}
function queueApi(handler:(action:string,payload:any)=>unknown|Promise<unknown>):MarketApi{
 return (async<T=Record<string,unknown>>(action:string,payload:unknown={})=>await handler(action,payload) as T) as MarketApi;
}
test('market queues reject duplicates and apply explicit capacity limits',()=>{
 const proposals:{marketInbox?:MarketEvent[]}={},responses:{marketResponses?:MarketResponse[]}={};
 assert.equal(enqueueMarketEvent(proposals,queueProposal('p1')),'queued');
 assert.equal(enqueueMarketEvent(proposals,queueProposal('p1')),'duplicate');
 for(let i=2;i<=MAX_MARKET_PROPOSALS;i++)assert.equal(enqueueMarketEvent(proposals,queueProposal('p'+i)),'queued');
 assert.equal(enqueueMarketEvent(proposals,queueProposal('p-overflow')),'full');
 assert.equal(proposals.marketInbox?.length,MAX_MARKET_PROPOSALS);
 assert.equal(enqueueMarketResponse(responses,queueResponse('r1')),'queued');
 assert.equal(enqueueMarketResponse(responses,queueResponse('r1')),'duplicate');
 for(let i=2;i<=MAX_MARKET_RESPONSES;i++)assert.equal(enqueueMarketResponse(responses,queueResponse('r'+i)),'queued');
 assert.equal(enqueueMarketResponse(responses,queueResponse('r-overflow')),'full');
 assert.equal(responses.marketResponses?.length,MAX_MARKET_RESPONSES);
});
test('one temporary ingest failure does not block later proposals and uses backoff',async()=>{
 const state={marketInbox:[queueProposal('fails'),queueProposal('succeeds')]},delivered:string[]=[];
 const bridge=queueApi((action,payload:any)=>{assert.equal(action,'ingest');if(payload.messageId==='fails')throw Error('temporary outage');delivered.push(payload.messageId);return {success:true};});
 await drainMarketInbox(state,bridge,async()=>{},async()=>true,5000);
 assert.deepEqual(delivered,['succeeds']);
 assert.equal(state.marketInbox.length,1);assert.equal(state.marketInbox[0]?.attempts,1);assert.equal(state.marketInbox[0]?.retryAt,20000);
 await drainMarketInbox(state,bridge,async()=>{},async()=>true,20000);
 assert.deepEqual(delivered,['succeeds','fails']);assert.equal(state.marketInbox.length,0);
});
test('one failed response does not block later negotiation confirmations',async()=>{
 const state={marketResponses:[queueResponse('fails'),queueResponse('succeeds')]},delivered:string[]=[];
 const bridge=queueApi((action,payload:any)=>{assert.equal(action,'response');if(payload.messageId==='fails')throw Error('temporary outage');delivered.push(payload.messageId);return {success:true};});
 await drainMarketResponses(state,bridge,async()=>{},5000);
 assert.deepEqual(delivered,['succeeds']);
 assert.equal(state.marketResponses.length,1);assert.equal(state.marketResponses[0]?.attempts,1);assert.equal(state.marketResponses[0]?.retryAt,20000);
});
test('oversized transfer message is ignored safely before proposal parsing',()=>{
 assert.equal(marketEvent(event.group,'large',event.participant,'x'.repeat(16001),[{group:event.group,kind:'transfer'}]),null);
});
