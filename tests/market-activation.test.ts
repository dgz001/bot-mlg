import test from 'node:test';
import assert from 'node:assert/strict';
import {activateMarketTransfers,canProcessMarketEvent,marketTransfersActive} from '../src/infra/market-activation.ts';

test('transfer capture is closed by default; trade capture is unaffected',()=>{
 const state={};
 assert.equal(marketTransfersActive(state),false);
 assert.equal(canProcessMarketEvent(state,{kind:'transfer',queuedAt:10}),false);
 assert.equal(canProcessMarketEvent(state,{kind:'trade',queuedAt:10}),true);
});

test('only an authorized activation timestamp opens capture for new proposals',()=>{
 const state={};
 const result=activateMarketTransfers(state,1000);
 assert.deepEqual(result,{activated:true,activatedAt:1000});
 assert.equal(canProcessMarketEvent(state,{kind:'transfer',queuedAt:999}),false);
 assert.equal(canProcessMarketEvent(state,{kind:'transfer',queuedAt:1000}),true);
 assert.equal(canProcessMarketEvent(state,{kind:'transfer',queuedAt:1001}),true);
 assert.equal(canProcessMarketEvent(state,{kind:'transfer'}),false);
});

test('repeated activation is idempotent and cannot move the start time',()=>{
 const state={};
 activateMarketTransfers(state,1000);
 assert.deepEqual(activateMarketTransfers(state,2000),{activated:false,activatedAt:1000});
 assert.equal(state.marketTransfersActivatedAt,1000);
});

test('invalid activation timestamps are rejected',()=>{
 assert.throws(()=>activateMarketTransfers({},0),/timestamp/);
 assert.throws(()=>activateMarketTransfers({},1.5),/timestamp/);
});
