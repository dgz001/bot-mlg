import test from 'node:test';
import assert from 'node:assert/strict';
import {rosterTick,ROSTER_REQUEST_INTERVAL_MS,type RosterConfig} from '../src/infra/roster-collection.ts';

const config:RosterConfig={enabled:true,group:'rosters@g.us',run:'cycle-1',opened:false,directory:Array.from({length:25},(_,i)=>({id:'club-'+i,name:'Club '+i,recipient:(1000+i)+'@s.whatsapp.net'}))};
const noopPhoto=async()=>{};
const noopProgress=async()=>{};
const tick=(holder:any,now:number,sends:string[],fail=false)=>rosterTick(holder,config,async()=>{},async(recipient,_body,id)=>{sends.push(id);if(fail)throw Error('simulated send failure');},noopPhoto,noopProgress,[],now);

test('sends at most one initial roster request per paced interval',async()=>{
 const holder:any={},sends:string[]=[];
 await tick(holder,1_000,sends);
 assert.equal(sends.length,1);
 assert.equal(holder.rosterCollection.entries.filter((e:any)=>e.requested).length,1);
 assert.equal(holder.rosterCollection.nextRequestAt,1_000+ROSTER_REQUEST_INTERVAL_MS);
 await tick(holder,1_000+ROSTER_REQUEST_INTERVAL_MS-1,sends);
 assert.equal(sends.length,1);
 await tick(holder,1_000+ROSTER_REQUEST_INTERVAL_MS,sends);
 assert.equal(sends.length,2);
 assert.equal(new Set(sends).size,2);
});

test('persisted pacing survives restart and resumes without duplicate requests',async()=>{
 const holder:any={},sends:string[]=[];
 await tick(holder,5_000,sends);
 const restarted:any={rosterCollection:structuredClone(holder.rosterCollection)};
 const before=sends.length;
 await tick(restarted,5_000+ROSTER_REQUEST_INTERVAL_MS-1,sends);
 assert.equal(sends.length,before);
 await tick(restarted,5_000+ROSTER_REQUEST_INTERVAL_MS,sends);
 assert.equal(sends.length,before+1);
 assert.equal(restarted.rosterCollection.entries.filter((e:any)=>e.requested).length,2);
});

test('failed send retains pacing lease and retries only after interval with same idempotency key',async()=>{
 const holder:any={},sends:string[]=[];
 await assert.rejects(tick(holder,9_000,sends,true),/Roster deliveries awaiting retry/);
 assert.equal(holder.rosterCollection.entries[0].requested,undefined);
 const failedId=sends[0];
 await tick(holder,9_000+ROSTER_REQUEST_INTERVAL_MS-1,sends);
 assert.equal(sends.length,1);
 await tick(holder,9_000+ROSTER_REQUEST_INTERVAL_MS,sends);
 assert.equal(sends.length,2);
 assert.equal(sends[1],failedId);
 assert.equal(holder.rosterCollection.entries[0].requested,true);
});


test('three failed attempts defer one club and allow the remaining directory to progress',async()=>{
 const holder:any={},sends:string[]=[];
 for(let attempt=0;attempt<3;attempt++){
  await assert.rejects(tick(holder,20_000+attempt*ROSTER_REQUEST_INTERVAL_MS,sends,true),/Roster deliveries awaiting retry/);
 }
 const first=holder.rosterCollection.entries[0];
 assert.equal(first.requestFailures,3);
 assert.equal(first.requestDeferred,true);
 await tick(holder,20_000+3*ROSTER_REQUEST_INTERVAL_MS,sends,false);
 assert.equal(holder.rosterCollection.entries[1].requested,true);
 assert.equal(holder.rosterCollection.entries[0].requested,undefined);
 assert.equal(sends.length,4);
 assert.notEqual(sends[3],sends[0]);
 assert.match(holder.rosterCollection.summary,/Solicitação não enviada após 3 tentativas/);
});
