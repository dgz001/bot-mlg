import test from 'node:test';
import assert from 'node:assert/strict';
import {allowsGroup,groupMode,validGroupMode} from '../src/infra/group-modes.ts';
import {createBanterReply} from '../src/resenha/reply.ts';

test('group modes separate banter and tournament, with legacy continuity',()=>{
 const modes={resenha:'resenha',copa:'minicamp'} as const;
 assert.equal(allowsGroup(modes,'resenha','resenha'),true);
 assert.equal(allowsGroup(modes,'resenha','minicamp'),false);
 assert.equal(allowsGroup(modes,'copa','resenha'),false);
 assert.equal(allowsGroup(modes,'copa','minicamp'),true);
 assert.equal(groupMode(modes,'legacy'),'both');
 assert.equal(validGroupMode('admin'),false);
});

test('community jokes reflect the archive without inventing official results',()=>{
 const reply=createBanterReply({});
 assert.match(reply('g','o Van vai negociar de novo?'),/Van|negocia/);
 assert.match(reply('g','fala do Arthur'),/Arthur|zaga/);
 assert.match(reply('g','a internet do Anderson caiu?'),/Anderson|roteador|conexão/);
});
