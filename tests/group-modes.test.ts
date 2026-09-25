import test from 'node:test';
import assert from 'node:assert/strict';
import {allowsGroup,groupMode,validGroupMode} from '../src/infra/group-modes.ts';
import {createBanterReply} from '../src/resenha/reply.ts';

test('group modes separate banter and tournament, with legacy continuity',()=>{
 const modes={resenha:'resenha',copa:'minicamp',central:'controle'} as const;
 assert.equal(allowsGroup(modes,'resenha','resenha'),true);
 assert.equal(allowsGroup(modes,'resenha','minicamp'),false);
 assert.equal(allowsGroup(modes,'copa','resenha'),false);
 assert.equal(allowsGroup(modes,'copa','minicamp'),true);
 assert.equal(allowsGroup(modes,'central','resenha'),false);
 assert.equal(allowsGroup(modes,'central','minicamp'),false);
 assert.equal(validGroupMode('controle'),true);
 assert.equal(groupMode(modes,'legacy'),'both');
 assert.equal(validGroupMode('admin'),false);
});

test('community jokes reflect the archive without inventing official results',()=>{
 const reply=createBanterReply({});
 assert.match(reply('g','o Van vai negociar de novo?'),/Van|negocia/);
 assert.match(reply('g','fala do Arthur'),/Arthur|zaga/);
 assert.match(reply('g','a internet do Anderson caiu?'),/Anderson|roteador|conexão/);
 assert.match(reply('g','o GS vai jogar com Amério?'),/GS|Amério/);
 assert.match(reply('g','e o Ronald na Roma?'),/Ronald|Roma/);
 assert.match(reply('g','Rafa Santos vai jogar?'),/Rafa Santos/);
 assert.match(reply('g','mercado e negociação da janela'),/janela|negocia|Mercado|elenco|proposta|privado|Mercado/i);
 for(const question of ['Amério ganhou do GS?', 'Van é vingativo?', 'o Ronald vai ser campeão?']){
  const response=reply('g',question);
  assert.doesNotMatch(response,/\+?\d[\d\s()-]{8,}\d|campeão oficial|venceu por \d+x\d+/i);
 }
});
