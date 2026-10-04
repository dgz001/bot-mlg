import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Edge module has no declaration file.
import {guestFixtures,guestStandings} from '../deploy/guest-competition.ts';

test('liga com número ímpar gera cada confronto uma vez e inverte o mando na volta',()=>{
 const ids=['a','b','c','d','e'];
 const games=guestFixtures('liga',2,ids);
 assert.equal(games.length,ids.length*(ids.length-1));
 const pairs=new Map<string,typeof games>();
 for(const game of games){const key=[game.home,game.away].sort().join('-');pairs.set(key,[...(pairs.get(key)??[]),game]);}
 assert.equal(pairs.size,10);
 for(const pair of pairs.values()){assert.equal(pair.length,2);assert.equal(pair[0]!.home,pair[1]!.away);assert.equal(pair[0]!.away,pair[1]!.home);}
 assert.equal(new Set(games.map((m:{round:number;position:number;leg:number})=>`${m.round}-${m.position}-${m.leg}`)).size,games.length);
});

test('mata-mata de ida e volta cria dois códigos por confronto e aceita empate na classificação da liga',()=>{
 const games=guestFixtures('copa',2,['a','b','c','d']);
 assert.equal(games.length,4);assert.deepEqual(games.map((m:{leg:number})=>m.leg),[1,2,1,2]);
 const players=[{user_id:'a',display_name:'A',team:'Bahia'},{user_id:'b',display_name:'B',team:'Santos'}];
 const rows=guestStandings(players,[{home:'a',away:'b',status:'confirmed',home_score:2,away_score:2}]);
 assert.equal(rows[0].points,1);assert.equal(rows[1].points,1);assert.equal(rows[0].draws,1);
});
// @ts-ignore Private Edge module is tested without a live connection.
import {platformLoan} from '../deploy/platform-loan.ts';
test('platform lending rejects malformed actors and never grants unavailable groups',async()=>{
 let queries=0;const db={transaction:async(run:any)=>run({query:async()=>{queries++;return {rows:[]};}})};
 const identity=async()=>{throw Error('must not resolve an organizer');};
 await assert.rejects(platformLoan(db,{platformActor:'invalid',group:'12345@g.us',operation:'grant'},identity));assert.equal(queries,0);
 const result=await platformLoan(db,{platformActor:'11111111-1111-4111-8111-111111111111',group:'12345@g.us',operation:'grant'},identity);assert.ok(result.error);assert.equal(queries,1);
});
