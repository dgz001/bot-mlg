import test from 'node:test';
import {Script} from 'node:vm';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {privateControl,validControlToken} from '../src/infra/private-control.ts';
test('painel privado: senha forte, origem e bloqueio de tentativas',async()=>{
 const secret='x'.repeat(43);
 assert.equal(validControlToken('Bearer '+secret,secret),true);
 assert.equal(validControlToken('Bearer '+secret+'x',secret),false);
 assert.equal(validControlToken('Bearer short','short'),false);
 const handler=privateControl({secret,origin:'https://bot.example',socketPath:'/tmp/nonexistent-mlg-test.sock'});
 const server=createServer((req,res)=>{void handler(req,res);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const addr=server.address();assert.ok(addr&&typeof addr==='object');const base='http://127.0.0.1:'+addr.port;
 try {
 const page=await fetch(base);assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store');assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));const html=await page.text();assert.ok(!html.includes(secret));const script=/<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];assert.ok(script);assert.doesNotThrow(()=>new Script(script));
 const nodes=new Map<string,any>();let calls=0;
 const dom={getElementById(id:string){if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);},addEventListener(){}};
 new Script(script).runInNewContext({document:dom,AbortSignal,setTimeout,clearTimeout,fetch:async(url:string,options:any)=>{if(url==='/control')return {ok:false,json:async()=>({error:'Senha inválida'})};calls++;assert.equal(url,'/readyz');assert.equal(options.headers,undefined);return {ok:true,text:async()=> 'OK'};}});
 await nodes.get('wake').onclick();assert.equal(calls,1);assert.equal(nodes.get('wake').disabled,false);assert.match(nodes.get('wake-status').textContent,/Bot pronto/);
 const call=(origin:string,token:string,action='status')=>fetch(base+'/control',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-MLG-Control':'1',Authorization:'Bearer '+token},body:JSON.stringify({action})});
 const anonymous=()=>fetch(base+'/control',{method:'POST',headers:{Origin:'https://bot.example','Content-Type':'application/json','X-MLG-Control':'1'},body:'{"action":"status"}'});
 for(let i=0;i<8;i++)assert.equal((await anonymous()).status,401);
 assert.equal((await call('https://bot.example',secret,'reset-session')).status,400);
 assert.equal((await call('https://evil.example',secret)).status,403);
 for(let i=0;i<5;i++)assert.equal((await call('https://bot.example','wrong')).status,401);
 assert.equal((await call('https://bot.example',secret)).status,429);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('reinício exige senha e origem corretas, funciona sem socket do bot',async()=>{
 const secret='r'.repeat(43);let restarted=0;
 const handler=privateControl({secret,origin:'https://bot.example',socketPath:'/tmp/missing-worker.sock',restart:()=>{restarted++;return {restarting:true,phase:'RESTARTING'};}});
 const server=createServer((req,res)=>{void handler(req,res);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const addr=server.address();assert.ok(addr&&typeof addr==='object');const base='http://127.0.0.1:'+addr.port;
 const call=(origin:string,token:string)=>fetch(base+'/control',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-MLG-Control':'1',Authorization:'Bearer '+token},body:JSON.stringify({action:'restart'})});
 try{
  assert.equal((await call('https://evil.example',secret)).status,403);
  assert.equal((await call('https://bot.example','wrong')).status,401);assert.equal(restarted,0);
  const r=await call('https://bot.example',secret);assert.equal(r.status,202);assert.equal((await r.json() as any).restarting,true);assert.equal(restarted,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('troca de senha exige autenticação e invalida a senha anterior imediatamente',async()=>{
 let password='a'.repeat(43);
 const handler=privateControl({secret:password,origin:'https://bot.example',socketPath:'/tmp/missing-worker.sock',
  authenticate:async header=>header==='Bearer '+password,
  rotatePassword:async(header,next)=>{if(header!=='Bearer '+password||typeof next!=='string'||next.length<32)throw Error('Senha inválida.');password=next;}});
 const server=createServer((req,res)=>{void handler(req,res);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const addr=server.address();assert.ok(addr&&typeof addr==='object');
 const call=(token:string,next:string)=>fetch('http://127.0.0.1:'+addr.port+'/control',{method:'POST',headers:{Origin:'https://bot.example','Content-Type':'application/json','X-MLG-Control':'1',Authorization:'Bearer '+token},body:JSON.stringify({action:'change-password',newPassword:next})});
 try{
  const old=password,next='b'.repeat(43);
  assert.equal((await call('wrong',next)).status,401);
  assert.equal((await call(old,'short')).status,400);
  assert.equal((await call(old,next)).status,200);
  assert.equal((await call(old,'c'.repeat(43))).status,401);
  assert.equal((await call(next,'c'.repeat(43))).status,200);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('navegador usa sessão protegida sem reenviar senha e rotação invalida sessão antiga',async()=>{
 let password='s'.repeat(43),restarts=0;
 const handler=privateControl({secret:password,origin:'https://bot.example',socketPath:'/tmp/missing-worker.sock',
  authenticate:async header=>header==='Bearer '+password,
  rotatePassword:async(header,next)=>{if(header!=='Bearer '+password||typeof next!=='string'||next.length<32)throw Error('Senha inválida');password=next;},
  restart:()=>{restarts++;return {restarting:true,phase:'RESTARTING'};}});
 const server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const addr=server.address();assert.ok(addr&&typeof addr==='object');const base='http://127.0.0.1:'+addr.port;
 const call=(path:string,cookie?:string,bearer?:string,action='restart',next?:string)=>fetch(base+path,{method:'POST',headers:{Origin:'https://bot.example','Content-Type':'application/json','X-MLG-Control':'1',...(cookie?{Cookie:cookie}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},body:JSON.stringify({action,newPassword:next})});
 try{
  assert.equal((await call('/control')).status,401);
  const initial=await call('/control',undefined,password);assert.equal(initial.status,202);
  const cookie=initial.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie?.startsWith('mlg_panel='));
  assert.equal((await call('/control',cookie)).status,202);
  const next='t'.repeat(43),changed=await call('/control',cookie,undefined,'change-password',next);
  assert.equal(changed.status,200);const fresh=changed.headers.get('set-cookie')?.split(';')[0];assert.ok(fresh);
  assert.equal((await call('/control',cookie)).status,401);
  assert.equal((await call('/control',fresh)).status,202);
  const logout=await call('/logout',fresh);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie')??'',/Max-Age=0/);
  assert.equal(restarts,3);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
