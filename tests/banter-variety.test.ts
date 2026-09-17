import {test} from 'node:test';
import assert from 'node:assert/strict';
import {banks,topicFor} from '../src/resenha/banks.ts';
import {chooseReply,type ReplyHistory} from '../src/resenha/variety.ts';
import {createBanterReply} from '../src/resenha/reply.ts';
import {matchupReply} from '../src/resenha/matchup.ts';
test('every topic exhausts at least 12 distinct replies before any repeat, including restart',()=>{
 for(const bank of Object.values(banks)){
  assert.ok(bank.length>=12);let history:ReplyHistory={};const seen=new Set();
  for(let i=0;i<bank.length;i++){const answer=chooseReply('group',bank,history);assert.ok(!seen.has(answer));seen.add(answer);history=JSON.parse(JSON.stringify(history));}
  assert.ok(seen.has(chooseReply('group',bank,history)));
  assert.ok(Object.values(history).flat().every(x=>/^[a-f0-9]{64}$/.test(x)));
 }
});
test('historical subjects have specific replies',()=>{
 for(const [text,topic] of [['internet travando','lag'],['quero revanche','rematch'],['nos penaltis','penalties'],['esse sorteio','draw'],['muda a formacao','tactics'],['que goleada','rout'],['boa noite','greeting']])assert.equal(topicFor(text!),topic);
 const history:ReplyHistory={};const seen=new Set();
 for(let i=0;i<12;i++){const response=createBanterReply(history)('g','quero revanche');assert.ok(!seen.has(response));seen.add(response);}
});
test('matchup rotates all 32 templates without changing pick, even after serialization',()=>{
 const roster=[{name:'Alfa',club:'Clube A',aliases:[]},{name:'Beta',club:'Clube B',aliases:[]}];let h:ReplyHistory={};const seen=new Set();
 for(let i=0;i<32;i++){const result=matchupReply('Alfa x Beta quem ganha',roster,'g',options=>chooseReply('g',options,h))!;assert.ok(!seen.has(result));seen.add(result);h=JSON.parse(JSON.stringify(h));}
});
