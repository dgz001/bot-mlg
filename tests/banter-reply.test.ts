import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBanterReply,topicFor} from '../src/resenha/reply.ts';
test('resenha chooses the subject of the actual message',()=>{
 assert.equal(topicFor('vou perder'),'defeat');
 assert.equal(topicFor('Van fechou o elenco'),'market');
 assert.equal(topicFor('GS tá chorando'),'complaints');
 assert.equal(topicFor('Amério ganhou do GS'),'victory');
 assert.equal(topicFor('vou fugir'),'escape');
 assert.equal(topicFor('boa noite'),'general');
});
test('no adjacent repeated response and no copying private input',()=>{
 const reply=createBanterReply();let prev='';
 for(let i=0;i<30;i++){const next=reply('g','vou perder senha=SEGREDO');assert.notEqual(next,prev);assert.ok(!next.includes('SEGREDO'));assert.ok(next.length<180);prev=next;}
});
