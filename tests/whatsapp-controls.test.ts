import test from 'node:test';
import assert from 'node:assert/strict';
import {whatsappControls} from '../src/infra/whatsapp-controls.ts';

test('central responde mesmo com bot pausado e acordar restaura a Copa sem alterar a resenha',()=>{
 const paused={enabled:false,minicamp:false,resenha:false};
 assert.match(whatsappControls('!statusbot',paused)!.text,/Respostas pausadas/);
 assert.deepEqual(whatsappControls('!acordarbot',paused)!.next,{enabled:true,minicamp:true,resenha:false});
 assert.deepEqual(whatsappControls('!desligarbot',{enabled:true,minicamp:true,resenha:false})!.next,{enabled:false,minicamp:true,resenha:false});
 assert.equal(whatsappControls('!reiniciarbot',paused)!.restart,true);
 assert.deepEqual(whatsappControls('!resenha ligar',paused)!.next,{enabled:false,minicamp:false,resenha:true});
 assert.equal(whatsappControls('!novacopa',paused),null);
});
