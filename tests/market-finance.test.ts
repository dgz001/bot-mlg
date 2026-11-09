import test from 'node:test';
import assert from 'node:assert/strict';
import {INITIAL_MARKET_FINANCE,assessLocalMarketFinance,findMarketFinanceClub,normalizeMarketClub} from '../src/infra/market-finance.ts';

test('initial ledger has all 25 clubs and the supplied balances and sales counters',()=>{
 assert.equal(INITIAL_MARKET_FINANCE.clubs.length,25);
 const villa=findMarketFinanceClub(INITIAL_MARKET_FINANCE.clubs,'Aston Villa')!;
 assert.equal(villa.balanceMillions,125);assert.equal(villa.salesUsed,3);
 const leverkusen=findMarketFinanceClub(INITIAL_MARKET_FINANCE.clubs,'Bayer Leverkusen')!;
 assert.equal(leverkusen.balanceMillions,117.5);assert.equal(leverkusen.salesUsed,3);
 assert.equal(findMarketFinanceClub(INITIAL_MARKET_FINANCE.clubs,'Beşiktaş')?.balanceMillions,-7);
});
test('club lookup ignores accents and common aliases',()=>{
 assert.equal(normalizeMarketClub('Atlético de Madrid'),normalizeMarketClub('Atletico de Madrid'));
 assert.equal(findMarketFinanceClub(INITIAL_MARKET_FINANCE.clubs,'Man City')?.name,'Manchester City');
 assert.equal(findMarketFinanceClub(INITIAL_MARKET_FINANCE.clubs,'Barça')?.name,'Barcelona');
});
test('finance assessment warns when buyer cannot afford proposal and reports seller sales quota',()=>{
 const alerts=assessLocalMarketFinance({kind:'transfer',purchaseScope:'internal',origin:'Aston Villa',destination:'Porto',amountEuros:'15000000'},INITIAL_MARKET_FINANCE);
 assert.ok(alerts.some(a=>a.includes('Saldo possivelmente insuficiente')));
 assert.ok(alerts.some(a=>a.includes('Aston Villa: 3/5')));
});
test('sales cap is escalated to admins without automatically changing counters',()=>{
 const state=structuredClone(INITIAL_MARKET_FINANCE);
 const club=findMarketFinanceClub(state.clubs,'Benfica')!;club.salesUsed=5;
 const before=club.salesUsed;
 const alerts=assessLocalMarketFinance({kind:'transfer',purchaseScope:'internal',origin:'Benfica',destination:'Real Madrid',amountEuros:'1000000'},state);
 assert.ok(alerts.some(a=>a.includes('LIMITE DE VENDAS ATINGIDO')));
 assert.equal(club.salesUsed,before);
});
test('external purchases do not consume a MLG club sales quota and trades do not consume sales',()=>{
 const external=assessLocalMarketFinance({kind:'transfer',purchaseScope:'external',origin:'Externo',destination:'Napoli',amountEuros:'1000000'},INITIAL_MARKET_FINANCE);
 assert.ok(!external.some(a=>a.includes('Cota de vendas')));
 const trade=assessLocalMarketFinance({kind:'trade',purchaseScope:'trade',origin:'Napoli',destination:'Porto',amountEuros:'0'},INITIAL_MARKET_FINANCE);
 assert.ok(trade.some(a=>a.includes('Troca: cotas')));
});
