import test from 'node:test';import assert from 'node:assert/strict';import {marketResponse} from '../src/infra/market-response.ts';
const base={group:'12345@g.us',messageId:'reply',participant:'123@lid',proposalMessageId:'original'};
test('quoted confirmation and rejection carry original proposal and actual responding identity',()=>{assert.equal(marketResponse({...base,text:'Confirmo!'})?.decision,'positive');assert.equal(marketResponse({...base,text:'Não aceito'})?.decision,'negative');assert.equal(marketResponse({...base,reaction:'✅'})?.proposalMessageId,'original');assert.equal(marketResponse({...base,reaction:'❌'})?.participant,'123@lid');});
test('ambiguous conversations are not interpreted as consent; unquoted confirmation remains unassociated',()=>{assert.equal(marketResponse({...base,text:'talvez confirme depois'}),null);assert.equal(marketResponse({...base,text:'confirmo a outra proposta'}),null);assert.equal(marketResponse({...base,proposalMessageId:null,text:'confirmo'})?.proposalMessageId,null);});

test('seller may reply eu confirmo or react green to the buyer proposal',()=>{assert.equal(marketResponse({...base,text:'Eu confirmo!'})?.decision,'positive');assert.equal(marketResponse({...base,reaction:'🟢'})?.decision,'positive');assert.equal(marketResponse({...base,text:'olha esse cara não confirmou'}),null);});

test('invalid or oversized participants and response bodies are ignored',()=>{
 assert.equal(marketResponse({...base,participant:'not-a-jid',text:'Confirmo'}),null);
 assert.equal(marketResponse({...base,participant:'123:4@s.whatsapp.net',text:'Confirmo'})?.decision,'positive');
 assert.equal(marketResponse({...base,text:'Confirmo'.padEnd(501,'x')}),null);
 assert.equal(marketResponse({...base,messageId:'x'.repeat(201),text:'Confirmo'}),null);
});
test('unassociated plain replies and ambiguous reaction text never become approval',()=>{
 assert.equal(marketResponse({...base,proposalMessageId:null,text:'Confirmo com ressalvas'}),null);
 assert.equal(marketResponse({...base,text:'Não confirmei ainda'}),null);
});
