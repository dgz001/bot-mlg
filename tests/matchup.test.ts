import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoster,matchupReply,resolveCoach} from '../src/resenha/matchup.ts';
const roster=[{club:'Porto',name:'Vinícius Machado',aliases:['vinicius']},{club:'Tottenham',name:'Vinícius',aliases:['vinicius tottenham']},{club:'Juventus',name:'Amério',aliases:['amerio']}];
test('names, clubs, accent handling and ambiguous first names',()=>{
 assert.equal(resolveCoach('Vinicius',roster).length,2);
 assert.equal(resolveCoach('Vinicius Tottenham',roster)[0]?.club,'Tottenham');
 assert.equal(resolveCoach('Amério',roster)[0]?.club,'Juventus');
 assert.match(matchupReply('Porto x Juventus quem ganha?',roster,'g')!,/Vinícius Machado.*Porto.*Amério.*Juventus/s);
 assert.match(matchupReply('quem ganha entre Vinicius ou Amério?',roster,'g')!,/Qual técnico/);
 assert.match(matchupReply('Porto x Vinicius Machado quem ganha',roster,'g')!,/mesmo técnico/);
 assert.match(matchupReply('quem ganha desconhecido x Juventus',roster,'g')!,/Qual técnico/);
 assert.equal(matchupReply('oi',roster,'g'),null);
});
test('predictions are explicit guesses stable under reversed sides',()=>{
 const a=matchupReply('Porto x Juventus quem ganha',roster,'g')!.split('Meu chute de resenha: ')[1]!.split('!')[0];
 const b=matchupReply('Juventus x Porto quem ganha',roster,'g')!.split('Meu chute de resenha: ')[1]!.split('!')[0];assert.equal(a,b);
 assert.deepEqual(loadRoster(undefined),[]);assert.throws(()=>loadRoster('{}'));
});
