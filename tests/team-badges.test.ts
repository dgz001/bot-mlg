import test from 'node:test';
import assert from 'node:assert/strict';
import {teamBadge,teamLabel} from '../src/minicamp/team-badges.ts';
import {worldCupCandidates} from '../src/minicamp/nations.ts';
import {minicampClubs} from '../src/minicamp/clubs.ts';

test('seleções recebem bandeiras e clubes aprovados recebem duas cores',()=>{
 assert.equal(worldCupCandidates.length,36);assert.equal(minicampClubs.length,89);
 for(const nation of worldCupCandidates)assert.ok(teamBadge(nation,'seleção').length>=4,nation);
 for(const club of minicampClubs)assert.ok(Array.from(teamBadge(club,'clube')).length>=2,club);
 assert.match(teamLabel('Brasil','seleção'),/🇧🇷 Brasil/);
 assert.match(teamLabel('Flamengo','clube'),/🔴⚫ Flamengo/);
 assert.match(teamLabel('Santos','clube'),/⚫⚪ Santos/);
 assert.match(teamLabel('Boca Juniors','clube'),/🔵🟡 Boca Juniors/);
 assert.match(teamLabel('Brasil','clube'),/🇧🇷 Brasil/);
 assert.equal(teamLabel('Clube criado','clube'),'⚪⚫ Clube criado');
});
