import test from 'node:test';import assert from 'node:assert/strict';
import {marketBridge,marketEvent,drainMarketInbox,deliverMarketReactions} from '../src/infra/platform-market.ts';
const text='💰 PROPOSTA DE COMPRA\nClube de origem: Manchester City\nJogador: Mateus Nunes\nClube de destino: Galatasaray\nValor da transferência: €5 milhões';
const event=marketEvent('12345@g.us','MESSAGE','123456789@s.whatsapp.net',text,[{kind:'transfer',group:'12345@g.us'}])!;
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
