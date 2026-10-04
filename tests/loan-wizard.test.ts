import test from 'node:test';import assert from 'node:assert/strict';
import {loanWizard} from '../src/infra/loan-wizard.ts';import {guestPrepared,type ControlWorkspace} from '../src/infra/admin-control.ts';
const noSave=async()=>{};
test('private setup asks six questions, persists progress and saves only after final confirmation',async()=>{
 let room:ControlWorkspace={};assert.match((await loanWizard('!configbot',room,noSave))!,/Como se chama/);
 for(const answer of ['Copa Amigos','copa','4','2','Roma | Milan | Inter | Napoli','não']){
  const result=await loanWizard(answer,room,noSave);assert.ok(result);assert.equal(room.guestDraft,undefined);room=JSON.parse(JSON.stringify(room));
 }
 assert.equal(room.guestWizard?.field,'review');assert.match((await loanWizard('!confirmar',room,noSave))!,/salva/);
 assert.equal(room.guestWizard,undefined);assert.equal(guestPrepared(room)?.name,'Copa Amigos');assert.equal(guestPrepared(room)?.legs,2);
});
test('rejecting an edit preserves the previous configuration and retries do not create another wizard',async()=>{
 const room:ControlWorkspace={guestDraft:{name:'Copa Original',mode:'copa',legs:1,size:4,teams:['Roma','Milan','Inter','Napoli']},guestImage:'text'};
 const original=JSON.stringify(room.guestDraft);await loanWizard('!alterarconfig',room,noSave);await loanWizard('nome',room,noSave);await loanWizard('Novo nome',room,noSave);
 assert.equal(JSON.stringify(room.guestDraft),original);assert.equal(room.guestWizard?.field,'review');
 await loanWizard('!rejeitar',room,noSave);assert.equal(JSON.stringify(room.guestDraft),original);assert.equal(room.guestWizard,undefined);
 await loanWizard('!configbot',room,noSave);const w=room.guestWizard;await loanWizard('!configbot',room,noSave);assert.equal(room.guestWizard,w);
});
test('a platform change invalidates a stale private confirmation instead of overwriting the ADM',async()=>{
 const room:ControlWorkspace={guestDraft:{name:'Original',mode:'copa',legs:1,size:4,teams:['Roma','Milan','Inter','Napoli']}};
 await loanWizard('!alterarconfig',room,noSave);await loanWizard('nome',room,noSave);await loanWizard('Private edit',room,noSave);
 room.guestDraft!.name='ADM update';assert.match((await loanWizard('!confirmar',room,noSave))!,/mudou pela plataforma/);assert.equal(room.guestDraft!.name,'ADM update');assert.equal(room.guestWizard,undefined);
});
test('invalid names and teams do not advance the guided setup; unrelated commands retain progress',async()=>{
 const room:ControlWorkspace={};assert.equal(await loanWizard('Olá',room,noSave),null);
 await loanWizard('!configbot',room,noSave);await loanWizard('A',room,noSave);assert.equal(room.guestWizard?.field,'name');
 assert.equal(await loanWizard('!painel',room,noSave),null);assert.equal(room.guestWizard?.field,'name');
 await loanWizard('!cancelarconfig',room,noSave);assert.equal(room.guestWizard,undefined);
});
