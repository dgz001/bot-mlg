import test from 'node:test';
import assert from 'node:assert/strict';
import {orderMessages} from '../src/minicamp/message-order.ts';

test('mensagens do mesmo lote seguem horário do WhatsApp e preservam chegada em empate',()=>{
 const batch=[{id:'terceiro',messageTimestamp:104},{id:'segundo',messageTimestamp:103},{id:'primeiro',messageTimestamp:{toNumber:()=>102}},{id:'empate',messageTimestamp:103}];
 assert.deepEqual(orderMessages(batch).map(m=>m.id),['primeiro','segundo','empate','terceiro']);
 assert.deepEqual(batch.map(m=>m.id),['terceiro','segundo','primeiro','empate']);
});
