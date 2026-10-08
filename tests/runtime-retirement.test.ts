import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {loanJoinBatch} from '../src/infra/loan-join-batch.ts';

test('pending loan groups rotate without losing or duplicating entries',()=>{
 const pending=Array.from({length:25},(_,i)=>String(i));
 const seen=new Set<string>();for(let i=0;i<3;i++)for(const g of loanJoinBatch(pending,10))seen.add(g);
 assert.equal(seen.size,25);assert.equal(pending.length,25);assert.equal(new Set(pending).size,25);
 assert.deepEqual(loanJoinBatch([],10),[]);
});

test('retired runtime stays alive without importing a WhatsApp worker',async()=>{
 const child=spawn(process.execPath,['src/worker.ts'],{env:{PATH:process.env.PATH,MLG_RUNTIME_DISABLED:'true',BOT_MODE:'resenha',PORT:'0'},stdio:['ignore','pipe','pipe']});
 try{
  const output=await new Promise<string>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Retired runtime did not start')),5000);
   child.once('error',e=>{clearTimeout(timer);reject(e);});
   child.once('exit',code=>{clearTimeout(timer);reject(Error('Unexpected exit '+code));});
   child.stdout.once('data',data=>{clearTimeout(timer);resolve(data.toString());});
  });
  assert.match(output,/RUNTIME_DISABLED/);assert.doesNotMatch(output,/CONNECTED|NEEDS_PAIRING/);
 }finally{child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('close',()=>resolve()));}
});
