import test from 'node:test';import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {cupMediaFor} from '../src/minicamp/media.ts';
test('sorteio e título usam arte MLG uma vez por evento, sem mídia nos demais comandos',async()=>{
 assert.equal(cupMediaFor('🏆 COPA MLG · EDIÇÃO 9\n📣 INSCRIÇÕES ABERTAS · 0/16 vagas'),'inscricoes');
 assert.equal(cupMediaFor('🏆 COPA MLG · EDIÇÃO 9\n📣 Inscrições abertas · 0/16 vagas'),'inscricoes');
 assert.equal(cupMediaFor('🎲 SORTEIO · COPA MLG\nTimes definidos'),'sorteio');
 assert.equal(cupMediaFor('📋 ELENCO ATUALIZADO · COPA\n🎲 SORTEIO REALIZADO'),'sorteio');
 assert.equal(cupMediaFor('🏆 CAMPEÃO DO MINICAMP MLG\nMaria'),'campeao');
 for(const text of ['🎲 SORTEIO ATUALIZADO · COPA','🗺️ CHAVE ATUALIZADA','✅ INSCRIÇÃO','!copa'])assert.equal(cupMediaFor(text),null);
 for(const file of ['mlg-inscricoes.png','mlg-sorteio.jpg','mlg-campeao.jpg']){
  const metadata=await stat(new URL('../assets/'+file,import.meta.url));assert.ok(metadata.size>10000&&metadata.size<4000000);
 }
});
