import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditTargets,adminAuditBody,auditContent,auditMessageId,isMarketWindowCommand,marketWindowCommandAction} from '../src/infra/admin-audit.ts';
test('audit targets include only configured administration groups',()=>{
 assert.deepEqual(adminAuditTargets(['market@g.us','admin@g.us','loan@g.us'],{['admin@g.us']:'controle',['market@g.us']:'transfer',['loan@g.us']:'controle'},['loan@g.us']),['admin@g.us']);
});
test('audit body records time, destination, message id and text',()=>{
 const body=adminAuditBody({at:0,destination:'5511999999999@s.whatsapp.net',messageId:'wamid-1',content:{text:'Transferência recebida'}});
 assert.match(body,/1970-01-01T00:00:00.000Z/);assert.match(body,/5511999999999/);assert.match(body,/wamid-1/);assert.match(body,/Transferência recebida/);
});
test('audit content never serializes image bytes',()=>{
 assert.equal(auditContent({image:Buffer.from('private-image')}),'[imagem enviada]');
 assert.match(auditMessageId('wamid-1','admin@g.us'),/^MLGAUDIT[A-F0-9]{24}$/);
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
