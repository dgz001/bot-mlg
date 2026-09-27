import test from 'node:test';import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import {cupMediaFor} from '../src/minicamp/media.ts';
test('sorteio e título usam arte MLG uma vez por evento, sem mídia nos demais comandos',async()=>{
 assert.equal(cupMediaFor('🎲 SORTEIO · COPA MLG\nTimes definidos'),'sorteio');
 assert.equal(cupMediaFor('📋 ELENCO ATUALIZADO · COPA\n🎲 SORTEIO REALIZADO'),'sorteio');
 assert.equal(cupMediaFor('🏆 CAMPEÃO DO MINICAMP MLG\nMaria'),'campeao');
 assert.equal(cupMediaFor('📝 RESULTADO ANOTADO\nPartida #123'),'partida');
 assert.equal(cupMediaFor('✅ RESULTADO CONFIRMADO\n#123'),'classificacao');
 assert.equal(cupMediaFor('📣 PRÓXIMA COPA · João'),'proxima-copa');
 for(const text of ['🎲 SORTEIO ATUALIZADO · COPA','🗺️ CHAVE ATUALIZADA','✅ INSCRIÇÃO','!copa'])assert.equal(cupMediaFor(text),null);
 for(const file of ['mlg-sorteio.jpg','mlg-campeao.jpg','mlg-partida.jpg','mlg-classificacao.jpg','mlg-proxima-copa.jpg']){
  const metadata=await stat(new URL('../assets/'+file,import.meta.url));assert.ok(metadata.size>10000&&metadata.size<500000);
 }
});
