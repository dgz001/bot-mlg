import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditTargets,auditMessageId,isMarketWindowCommand,marketWindowCommandAction,marketWindowCommandDelivery} from '../src/infra/admin-audit.ts';
test('audit targets include only configured administration groups',()=>{
 assert.deepEqual(adminAuditTargets(['market@g.us','admin@g.us','loan@g.us'],{['admin@g.us']:'controle',['market@g.us']:'transfer',['loan@g.us']:'controle'},['loan@g.us']),['admin@g.us']);
});
test('transfer window command parser accepts exact commands and surrounding whitespace only',()=>{
 assert.equal(isMarketWindowCommand('!transligar'),true);
 assert.equal(isMarketWindowCommand('!transdesligar'),true);
 assert.equal(isMarketWindowCommand('  !transligar  '),true);
 assert.equal(isMarketWindowCommand('!transligar agora'),false);
 assert.equal(isMarketWindowCommand('!transligar\\s'),false);
 assert.equal(isMarketWindowCommand('transligar'),false);
});

test('window command resolves the intended action after trimming',()=>{
 assert.equal(marketWindowCommandAction('  !transligar  '),'open');
 assert.equal(marketWindowCommandAction('!transdesligar'),'close');
 assert.equal(marketWindowCommandAction('!transligar agora'),null);
 assert.equal(marketWindowCommandAction(''),null);
});

test('only live WhatsApp notifications may change the transfer window',()=>{
 assert.equal(marketWindowCommandDelivery('notify','!transligar'),'execute');
 assert.equal(marketWindowCommandDelivery('notify',' !TRANSDESLIGAR '),'execute');
 assert.equal(marketWindowCommandDelivery('append','!transligar'),'retry');
 assert.equal(marketWindowCommandDelivery('append','!transdesligar'),'retry');
 assert.equal(marketWindowCommandDelivery('append','mensagem antiga'),'ignore');
 assert.equal(marketWindowCommandDelivery('remove','!transligar'),'ignore');
});
