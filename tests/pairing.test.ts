import test from 'node:test';import assert from 'node:assert/strict';import {requestReadyPairing,recoverRevokedSession} from '../src/whatsapp/pairing.ts';
test('pareamento aguarda conexão pronta e não usa conexão substituída',async()=>{
 let release!:()=>void,requested=0;
 const sock={waitForConnectionUpdate:async(check:(u:{qr?:string})=>Promise<boolean|undefined>)=>{assert.equal(await check({}),false);assert.equal(await check({qr:'synthetic-readiness-event'}),true);await new Promise<void>(r=>{release=r;});},requestPairingCode:async()=>{requested++;return 'TESTONLY';}};
 const pending=requestReadyPairing(sock,'test',false,()=>true);await new Promise(r=>setImmediate(r));assert.equal(requested,0);release();assert.equal(await pending,'TESTONLY');assert.equal(requested,1);
 await assert.rejects(()=>requestReadyPairing(sock,'test',true,()=>false));assert.equal(requested,1);
 await assert.rejects(()=>requestReadyPairing({...sock,waitForConnectionUpdate:async()=>{throw new Error('timeout');}},'test',false,()=>true));assert.equal(requested,1);
});

test('revoked WhatsApp session can pair again without erasing community settings or pending deliveries',()=>{
 const old={registered:true},state={creds:old},groups=['roster-group'],marketInbox=[{id:'pending'}],surveyAnswers=[{messageId:'reply'}];
 const data={creds:old,keys:{session:{old:'encrypted'}},sessionRevoked:true,groups,marketInbox,surveyAnswers,controls:{enabled:true}};
 assert.equal(recoverRevokedSession(data,state,()=>({registered:false})),true);
 assert.equal(state.creds,data.creds);assert.equal(state.creds.registered,false);assert.deepEqual(data.keys,{});assert.equal(data.sessionRevoked,false);
 assert.equal(data.groups,groups);assert.equal(data.marketInbox,marketInbox);assert.equal(data.surveyAnswers,surveyAnswers);assert.equal(data.controls.enabled,true);
 assert.equal(recoverRevokedSession(data,state,()=>{throw Error('must not reset twice');}),false);
});
test('registered session without a WhatsApp revocation is never reset',()=>{
 const creds={registered:true},data={creds,keys:{session:{valid:'encrypted'}},sessionRevoked:false},state={creds};
 assert.equal(recoverRevokedSession(data,state,()=>{throw Error('healthy session must remain');}),false);
 assert.equal(state.creds,creds);assert.equal(data.creds,creds);assert.deepEqual(data.keys,{session:{valid:'encrypted'}});
});
