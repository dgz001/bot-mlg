import test from 'node:test';import assert from 'node:assert/strict';import {banterRequest} from '../src/resenha/trigger.ts';
test('resenha aceita !bot com mensagem, comandos seguidos e menções',()=>{
 assert.equal(banterRequest('!bot fala da partida'),'fala da partida');
 assert.equal(banterRequest(' !BOT oi '),'oi');assert.equal(banterRequest('!bot'),'');
 assert.equal(banterRequest('!resenha'),'');assert.equal(banterRequest('!bot oi'),'oi');
 assert.equal(banterRequest('!bot segundo comando'),'segundo comando');
 assert.equal(banterRequest('!botao'),null);assert.equal(banterRequest('conversa comum'),null);
 assert.equal(banterRequest('fala aí',true),'fala aí');assert.equal(banterRequest('e aí?',false,true),'e aí?');
});
