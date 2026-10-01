import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {progressMessage} from '../src/whatsapp/progress-message.ts';

test('comando rápido envia somente a resposta definitiva',async()=>{
 const sent:any[]=[];
 const socket={sendMessage:async(_group:string,content:any)=>{sent.push(content);return {key:{id:'abc',remoteJid:'1@g.us',fromMe:true}};}};
 await progressMessage(socket,'1@g.us',()=>true,100)('✅ Feito');
 assert.deepEqual(sent,[{text:'✅ Feito'}]);
});

test('comando lento edita a espera e recupera de falha de edição',async()=>{
 const sent:any[]=[];let rejectEdit=false;
 const socket={sendMessage:async(_group:string,content:any)=>{sent.push(content);if(rejectEdit&&content.edit)throw Error('edit unavailable');return {key:{id:'abc',remoteJid:'1@g.us',fromMe:true}};}};
 let finish=progressMessage(socket,'1@g.us',()=>true,0);
 await new Promise(resolve=>setTimeout(resolve,10));
 await finish('✅ Feito');
 assert.equal(sent[0].text,'⏳ Processando seu comando…');
 assert.equal(sent[1].edit.id,'abc');
 finish=progressMessage(socket,'1@g.us',()=>true,0);rejectEdit=true;
 await new Promise(resolve=>setTimeout(resolve,10));
 await finish('⚠️ Confira o estado');
 assert.deepEqual(sent.at(-1),{text:'⚠️ Confira o estado'});
});
