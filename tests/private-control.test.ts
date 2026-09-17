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
 const call=(origin:string,token:string,action='status')=>fetch(base+'/control',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-MLG-Control':'1',Authorization:'Bearer '+token},body:JSON.stringify({action})});
 assert.equal((await call('https://evil.example',secret)).status,403);
 assert.equal((await call('https://bot.example',secret,'reset-session')).status,400);
 for(let i=0;i<5;i++)assert.equal((await call('https://bot.example','wrong')).status,401);
 assert.equal((await call('https://bot.example',secret)).status,429);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
