import test from 'node:test';import assert from 'node:assert/strict';
import {marketBridge,marketEvent,drainMarketInbox,deliverMarketReactions,canRecoverMarketMessage,marketHealthPayload,marketOperationsPayload,marketNoticeMessageId} from '../src/infra/platform-market.ts';
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
 const restarted=JSON.parse(JSON.stringify(persisted));await drainMarketInbox(restarted,api,async()=>{});
 assert.equal(effects,1);assert.equal(restarted.marketInbox.length,0);
});
test('health signal records backlog age without message contents or personal numbers',()=>{
 const signal=marketHealthPayload({marketInbox:[{...event,queuedAt:1000}],marketResponses:[{at:500}]},{phase:'CONNECTED',enabled:true,healthy:true,blocked:false,groups:['12345@g.us'],now:601000});
 assert.equal(signal.oldestAgeSeconds,600);assert.equal(signal.proposalQueue,1);assert.equal(signal.responseQueue,1);assert.ok(!JSON.stringify(signal).includes(event.text));assert.ok(!JSON.stringify(signal).includes(event.participant));
});
test('operations status exposes remaining capacity and full batches without leaking proposal content',()=>{
 const batches=[
  {group:'12345@g.us',batch:2,count:7,limit:10,botLocked:false},
  {group:'67890@g.us',batch:4,count:10,limit:10,botLocked:true}
 ];
 const status=marketOperationsPayload({marketInbox:[event],marketResponses:[]},{phase:'CONNECTED',enabled:true,healthy:true,blocked:true,groups:[],now:(event.queuedAt??Date.now())+30000},batches,[{kind:'transfer',group:'12345@g.us'},{kind:'trade',group:'67890@g.us'}]);
 assert.deepEqual(status.batches.map(b=>({kind:b.kind,remaining:b.remaining,full:b.full,botLocked:b.botLocked})),[
  {kind:'transfer',remaining:3,full:false,botLocked:false},
  {kind:'trade',remaining:0,full:true,botLocked:true}
 ]);
 assert.equal(status.proposalQueue,1);
 assert.ok(!JSON.stringify(status).includes(event.text));
 assert.ok(!JSON.stringify(status).includes(event.participant));
});
test('private and admin notices use stable, distinct WhatsApp message identifiers',()=>{
 const id='01234567-89ab-4cde-8fab-0123456789ab';
 assert.equal(marketNoticeMessageId('private',id),'MLGPRIV0123456789AB4CDE8FAB0123456789AB');
 assert.equal(marketNoticeMessageId('admin',id),'MLGADMIN0123456789AB4CDE8FAB0123456789AB');
 assert.equal(marketNoticeMessageId('private',id),marketNoticeMessageId('private',id));
 assert.throws(()=>marketNoticeMessageId('admin','not-a-uuid'));
});
test('capture only configured groups and flag a wrong template',()=>{assert.equal(marketEvent('other@g.us','id','123@lid',text,[{kind:'transfer',group:'12345@g.us'}]),null);assert.equal(event.parsed.amountEuros,'5000000');assert.ok(marketEvent('12345@g.us','id','123@lid',text,[{kind:'trade',group:'12345@g.us'}])!.parsed.issues.length);});
test('bridge sends token only to configured TLS Supabase endpoint',async()=>{let request:any;const api=marketBridge('https://fixture.supabase.co','public','a'.repeat(64),async(url,options)=>{request={url:String(url),options};return new Response('{"success":true}',{status:200});});await api('ingest',event);assert.equal(request.url,'https://fixture.supabase.co/rest/v1/rpc/bot_whatsapp_market_gate');assert.equal(JSON.parse(request.options.body).p_payload.messageId,'MESSAGE');assert.throws(()=>marketBridge('https://malicious.invalid','key','a'.repeat(64)));});
test('failed ingestion and failed persistence preserve exact message for retry',async()=>{const state={marketInbox:[event]};await assert.rejects(drainMarketInbox(state,(async()=>{throw Error('offline');}) as any,async()=>{}));assert.equal(state.marketInbox.length,1);await assert.rejects(drainMarketInbox(state,(async()=>({success:true})) as any,async()=>{throw Error('vault failed');}));assert.equal(state.marketInbox.length,1);await drainMarketInbox(state,(async()=>({success:true})) as any,async()=>{});assert.equal(state.marketInbox.length,0);});
test('reaction transport targets original message and ack failure never reruns financial operation',async()=>{const calls:any[]=[];const reaction={id:'uuid',revision:2,emoji:'🟢',lease:'lease',group:event.group,messageId:event.messageId,participant:event.participant};const api=(async(action:string,payload:any)=>{calls.push({action,payload});return action==='claim_reactions'?{reactions:[reaction]}:{success:true};}) as any;await deliverMarketReactions(api,async value=>assert.equal(value.messageId,'MESSAGE'),()=>true);assert.deepEqual(calls.map(c=>c.action),['claim_reactions','ack_reaction']);assert.equal(calls[1].payload.sent,true);calls.length=0;await deliverMarketReactions(api,async()=>{throw Error('WhatsApp offline');},()=>true);assert.equal(calls[1].payload.sent,false);});

test('admin and member submissions use the same batch path; notices and examples are ignored',()=>{
 const channels=[{kind:'transfer' as const,group:'12345@g.us'}];
 for(const participant of ['111@lid','222@lid'])assert.ok(marketEvent('12345@g.us','id',participant,text,channels));
 for(const notice of ['A proposta de compra deve ter os clubes e o jogador.','Esse jogador não está disponível na liga.','Ele ainda não confirmou.', 'MODELO DE EXEMPLO\n'+text,'EXEMPLO\n'+text,text.replace('Manchester City','[clube de origem]')])assert.equal(marketEvent('12345@g.us','id','111@lid',notice,channels),null);
 assert.ok(marketEvent('12345@g.us','id','111@lid',text.replace('PROPOSTA DE COMPRA','MÓDULO DE COMPRA'),channels));
});
test('closed batch preserves overflow proposals while allowing delivery work to continue',async()=>{
 const state={marketInbox:[event]};let saved=0;
 await drainMarketInbox(state,(async()=>({success:false,reason:'batch_closed'})) as any,async()=>{saved++;});
 assert.equal(state.marketInbox.length,1);assert.equal(saved,0);
 await drainMarketInbox(state,(async()=>({success:true})) as any,async()=>{saved++;});
 assert.equal(state.marketInbox.length,0);assert.equal(saved,1);
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

test('local confirmation parser recognizes emoji-only replies and common Portuguese confirmations',async()=>{ 
 const {marketResponse}=await import('../src/infra/market-response.ts');
 for(const value of ['✅','✅️','confirmo','Confirmo!','eu confirmo','confirmado','confirmo a troca']){
  const parsed=marketResponse({group:'12345@g.us',messageId:'reply-'+value,participant:'111@lid',proposalMessageId:'proposal',text:value});
  assert.equal(parsed?.decision,'positive',value);
 }
 assert.equal(marketResponse({group:'12345@g.us',messageId:'no',participant:'111@lid',text:'não aceito'})?.decision,'negative');
});
