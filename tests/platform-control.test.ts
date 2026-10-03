import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {platformControl,platformIdentity} from '../src/infra/platform-control.ts';

const user='11111111-1111-4111-8111-111111111111';
const token=(aal='aal1')=>['e30',Buffer.from(JSON.stringify({sub:user,aal})).toString('base64url'),'signature'].join('.');
test('identidade da plataforma valida usuário no Auth, papel atual no banco e MFA',async()=>{
 const urls:string[]=[];
 const identify=platformIdentity('https://zkvklcmwqsoptyvtmgkr.supabase.co','publishable',async(input)=>{
  const url=String(input);urls.push(url);
  return new Response(JSON.stringify(url.includes('/auth/')?{id:user,factors:[{status:'verified'}]}:true),{status:200});
 });
 assert.equal(await identify('Bearer '+token()),null);
 assert.deepEqual(await identify('Bearer '+token('aal2')),{id:user,admin:true});
 assert.equal(urls.filter(u=>u.includes('/rpc/is_admin')).length,1);
});
test('plataforma só executa controles para ADM autenticado e origem esperada',async()=>{
 let restarted=0,admin=false;
 const handler=platformControl({origin:'https://v0-mlg01.vercel.app',socketPath:'/tmp/nonexistent-platform.sock',identify:async()=>({id:user,admin}),restart:()=>{restarted++;return {restarting:true};}});
 const call=async(origin:string,action:string)=>{
  const req=Object.assign(Readable.from([JSON.stringify({action})]),{method:'POST',headers:{origin,authorization:'Bearer '+token(),'content-type':'application/json'}});
  const res={statusCode:200,headers:{} as Record<string,string>,setHeader(k:string,v:string){this.headers[k]=v;},writeHead(code:number){this.statusCode=code;return this;},end(){return this;}};
  await handler(req as never,res as never);return res.statusCode;
 };
 assert.equal(await call('https://evil.example','restart'),403);
 assert.equal(await call('https://v0-mlg01.vercel.app','restart'),403);
 admin=true;assert.equal(await call('https://v0-mlg01.vercel.app','restart'),202);assert.equal(restarted,1);
});
