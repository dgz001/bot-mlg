import test from 'node:test';import assert from 'node:assert/strict';
import {moduleEnabled,parseControls} from '../src/infra/bot-controls.ts';
test('controles bloqueiam ambos os módulos e permitem pausa independente',()=>{
 assert.equal(moduleEnabled(undefined,'resenha'),true);
 const off=parseControls({enabled:false,resenha:true,minicamp:true});
 assert.equal(moduleEnabled(off,'resenha'),false);assert.equal(moduleEnabled(off,'minicamp'),false);
 const partial=parseControls({enabled:true,resenha:false,minicamp:true});
 assert.equal(moduleEnabled(partial,'resenha'),false);assert.equal(moduleEnabled(partial,'minicamp'),true);
 for(const bad of [{enabled:'false',resenha:true,minicamp:true},{enabled:true},null,{enabled:true,resenha:true,minicamp:true,exec:'x'}])assert.throws(()=>parseControls(bad));
});
