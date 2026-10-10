import test from 'node:test';import assert from 'node:assert/strict';import {rosterTick,rosterTextReady,rosterMessageId,type RosterState,type RosterConfig} from '../src/infra/roster-collection.ts';
const text='GOLEIROS\nNeuer\nUrbig\nDEFENSORES\nA\nB\nC\nD\nMEIO-CAMPISTAS\nE\nF\nG\nATACANTES\nH\nI\nJ';
const config:RosterConfig={enabled:true,group:'12345@g.us',run:'run1',opened:false,directory:Array.from({length:25},(_,i)=>({id:String(i),name:'Club '+i,recipient:String(i)+'@s.whatsapp.net'}))};
test('list requires two keepers and full positions; stable delivery identifiers',()=>{assert.ok(rosterTextReady(text));assert.equal(rosterTextReady(text.replace('Urbig\n','')),false);assert.equal(rosterTextReady('Neuer\nUrbig'),false);assert.equal(rosterMessageId('r','c','text'),rosterMessageId('r','c','text'));assert.notEqual(rosterMessageId('r','c','text'),rosterMessageId('r','c','photo'));});
test('closed configured window requests exactly 25, pairs delayed photo, resumes delivery and reports ADM status',async()=>{
 const holder:{rosterCollection?:RosterState}={};const messages:string[]=[],photos:string[]=[],statuses:string[]=[];let saves=0;const send=async(r:string,t:string,id:string)=>{messages.push(id);},photo=async(e:any,g:string,id:string)=>{photos.push(id);},progress=async(e:any,s:string)=>{statuses.push(s);},save=async()=>{saves++};
 await rosterTick(holder,{...config,opened:true},save,send,photo,progress,[]);assert.equal(holder.rosterCollection,undefined);
 await rosterTick(holder,config,save,send,photo,progress,['23456@g.us']);assert.equal(holder.rosterCollection!.entries.length,25);assert.equal(messages.length,26);
 const e=holder.rosterCollection!.entries[0]!;e.text=text;await rosterTick(holder,config,save,send,photo,progress,['23456@g.us']);assert.equal(photos.length,0);assert.equal(e.delivered,undefined);e.image={reference:'synthetic'};
 let fail=true;const flaky=async(r:string,t:string,id:string)=>{if(t.includes('elenco final recebido')&&fail){fail=false;throw Error('Disconnected');}await send(r,t,id);};
 await assert.rejects(()=>rosterTick(holder,config,save,flaky,photo,progress,['23456@g.us']));assert.equal(e.photoSent,true);assert.equal(e.delivered,undefined);
 const recovered=JSON.parse(JSON.stringify(holder));await rosterTick(recovered,config,save,send,photo,progress,['23456@g.us']);assert.equal(photos.length,1);assert.equal(recovered.rosterCollection.entries[0].delivered,true);assert.ok(statuses.includes('delivered'));assert.ok(saves>25);
 const count=messages.length;await rosterTick(recovered,config,save,send,photo,progress,['23456@g.us']);assert.equal(messages.length,count);
});
