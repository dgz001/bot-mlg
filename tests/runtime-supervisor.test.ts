import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {RuntimeSupervisor} from '../src/infra/runtime-supervisor.ts';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {randomBytes} from 'node:crypto';

async function until(check:()=>boolean){
 const deadline=Date.now()+6000;
 while(!check()){if(Date.now()>deadline)throw Error('Supervisor timed out');await new Promise(r=>setTimeout(r,25));}
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'mlg-supervisor-'));
 const file=join(root,'worker.mjs');
 await writeFile(file,`setInterval(()=>process.send?.({type:'health',phase:'CONNECTED',ready:true}),30);process.on('SIGTERM',()=>process.exit(0));`);
 const supervisor=new RuntimeSupervisor({worker:pathToFileURL(file),env:{PATH:process.env.PATH},graceMs:200,retryMs:50,heartbeatMs:1000,checkMs:50,cooldownMs:60000});
 supervisor.start();await until(()=>supervisor.ready);
 return {supervisor,close:async()=>{await supervisor.stop();await rm(root,{recursive:true,force:true});}};
}
test('supervisor reinicia processo, recusa repetição e mantém instância única',async()=>{
 const f=await fixture();try{
  const old=f.supervisor.pid!;assert.equal(f.supervisor.restart().restarting,true);
  assert.equal(f.supervisor.ready,false);assert.throws(()=>f.supervisor.restart(),/Aguarde/);
  await until(()=>f.supervisor.ready&&f.supervisor.pid!==old);
  assert.throws(()=>process.kill(old,0));
 }finally{await f.close();}
});
test('supervisor recupera crash sem depender do painel',async()=>{
 const f=await fixture();try{
  const old=f.supervisor.pid!;process.kill(old,'SIGKILL');
  await until(()=>f.supervisor.ready&&f.supervisor.pid!==old);
 }finally{await f.close();}
});
test('supervisor recebe reinício solicitado pela central sem abrir uma segunda sessão',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mlg-wa-restart-'));
 const worker=join(root,'worker.mjs'),marker=join(root,'requested');
 await writeFile(worker,`import {existsSync,writeFileSync} from 'node:fs';
setInterval(()=>process.send?.({type:'health',phase:'CONNECTED',ready:true}),30);
if(!existsSync(process.env.MLG_TEST_RESTART_MARKER)){writeFileSync(process.env.MLG_TEST_RESTART_MARKER,'1');setTimeout(()=>process.send?.({type:'restart-request'}),100);}
process.on('SIGTERM',()=>process.exit(0));`);
 const supervisor=new RuntimeSupervisor({worker:pathToFileURL(worker),env:{PATH:process.env.PATH,MLG_TEST_RESTART_MARKER:marker},graceMs:200,retryMs:50,heartbeatMs:1000,checkMs:50});
 try{supervisor.start();const first=supervisor.pid;await until(()=>supervisor.ready&&supervisor.pid!==first);assert.ok(supervisor.pid);}
 finally{await supervisor.stop();await rm(root,{recursive:true,force:true});}
});
test('supervisor detecta processo travado e força encerramento antes de substituí-lo',{skip:process.platform==='win32'},async()=>{
 const f=await fixture();try{
  const old=f.supervisor.pid!;process.kill(old,'SIGSTOP');
  await until(()=>f.supervisor.ready&&f.supervisor.pid!==old);
  assert.throws(()=>process.kill(old,0));
 }finally{await f.close();}
});

// This integration uses Unix sockets, unavailable in the local restricted runner.
// It is mandatory in the isolated PostgreSQL build, where the real worker runs.
test('worker real: desligar persiste no cofre, reinício preserva pausa e painel religa',{skip:!process.env.MLG_TEST_DATABASE_URL},async()=>{
 let value:unknown=null;
 const vault=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer test-only'){res.writeHead(401).end();return;}
  if(req.method==='PUT'){let body='';for await(const chunk of req)body+=chunk.toString();value=JSON.parse(body);}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({value}));
 });
 await new Promise<void>(r=>vault.listen(0,'127.0.0.1',r));
 const address=vault.address();assert.ok(address&&typeof address==='object');
 const supervisor=new RuntimeSupervisor({worker:new URL('../src/resenha-worker.ts',import.meta.url),env:{PATH:process.env.PATH,SESSION_VAULT_URL:'http://127.0.0.1:'+address.port,SESSION_VAULT_TOKEN:'test-only',AUTH_ENCRYPTION_KEY:randomBytes(32).toString('hex'),CONTROL_PASSWORD:'t'.repeat(40),CONTROL_ORIGIN:'https://test.example'},retryMs:50,graceMs:2000});
 function call(data:unknown):Promise<any>{return new Promise((resolve,reject)=>{
  const c=connect('/tmp/mlg-bot-control.sock');let body='';
  c.setTimeout(4000,()=>c.destroy(new Error('timeout')));
  c.on('connect',()=>c.write(JSON.stringify(data)+'\n'));c.on('data',b=>body+=b);c.on('error',reject);c.on('end',()=>{try{resolve(JSON.parse(body));}catch(e){reject(e);}});
 });}
 supervisor.start();
 try{
  await until(()=>supervisor.phase==='NEEDS_PAIRING');
  const settings={enabled:false,resenha:true,minicamp:true};
  assert.equal((await call({action:'settings',settings})).updated,true);
  assert.equal((await call({action:'status'})).controls.enabled,false);
  const old=supervisor.pid!;supervisor.restart();
  await until(()=>supervisor.pid!==old&&supervisor.phase==='NEEDS_PAIRING');
  assert.deepEqual((await call({action:'status'})).controls,settings);
  assert.equal((await call({action:'settings',settings:{...settings,enabled:true}})).updated,true);
  assert.equal((await call({action:'status'})).controls.enabled,true);
  assert.ok(!JSON.stringify(value).includes('enabled'));
 }finally{await supervisor.stop();vault.closeAllConnections();await new Promise<void>(r=>vault.close(()=>r()));}
});
