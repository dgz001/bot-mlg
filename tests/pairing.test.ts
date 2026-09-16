import test from 'node:test';import assert from 'node:assert/strict';import {requestReadyPairing} from '../src/whatsapp/pairing.ts';
test('pareamento aguarda conexão pronta e não usa conexão substituída',async()=>{
 let release!:()=>void,requested=0;
 const sock={waitForConnectionUpdate:async(check:(u:{qr?:string})=>Promise<boolean|undefined>)=>{assert.equal(await check({}),false);assert.equal(await check({qr:'synthetic-readiness-event'}),true);await new Promise<void>(r=>{release=r;});},requestPairingCode:async()=>{requested++;return 'TESTONLY';}};
 const pending=requestReadyPairing(sock,'test',false,()=>true);await new Promise(r=>setImmediate(r));assert.equal(requested,0);release();assert.equal(await pending,'TESTONLY');assert.equal(requested,1);
 await assert.rejects(()=>requestReadyPairing(sock,'test',true,()=>false));assert.equal(requested,1);
 await assert.rejects(()=>requestReadyPairing({...sock,waitForConnectionUpdate:async()=>{throw new Error('timeout');}},'test',false,()=>true));assert.equal(requested,1);
});
