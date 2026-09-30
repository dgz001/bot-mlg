import test from 'node:test';
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {panelCredentials} from '../src/infra/panel-credentials.ts';

test('senha do painel persiste no cofre separado e invalida a anterior após reinício',async()=>{
 let saved: unknown=null;
 const requests: string[]=[];
 mock.method(globalThis,'fetch',async (url: string|URL|Request, options?: RequestInit)=>{
  requests.push(String(url));
  assert.match(String(url),/\/panel-credentials$/);
  assert.equal((options?.headers as Record<string,string>)?.Authorization,'Bearer vault-token');
  if(options?.method==='PUT'){saved=JSON.parse(String(options.body));return Response.json({saved:true});}
  return Response.json({value:saved});
 });
 try{
  const old='a'.repeat(43),next='b'.repeat(43);
  const first=panelCredentials('https://vault.example/functions/v1/session','vault-token',old);
  assert.equal(await first.verify('Bearer '+old),true);
  await first.rotate('Bearer '+old,next);
  const restarted=panelCredentials('https://vault.example/functions/v1/session','vault-token',old);
  assert.equal(await restarted.verify('Bearer '+old),false);
  assert.equal(await restarted.verify('Bearer '+next),true);
  assert.equal(JSON.stringify(saved).includes(next),false);
  assert.equal(requests.every(url=>url.endsWith('/panel-credentials')),true);
 }finally{mock.restoreAll();}
});

test('acesso de recuperação expira, pode trocar senha uma vez e não reaparece após reinício',async()=>{
 let saved: unknown=null;
 mock.method(globalThis,'fetch',async (_url: string|URL|Request, options?: RequestInit)=>{
  if(options?.method==='PUT'){saved=JSON.parse(String(options.body));return Response.json({saved:true});}
  return Response.json({value:saved});
 });
 const old='a'.repeat(43),next='b'.repeat(43),recovery='c'.repeat(43),replacement='d'.repeat(43);
 process.env.PANEL_RECOVERY_PASSWORD=recovery;
 process.env.PANEL_RECOVERY_UNTIL=String(Date.now()+600000);
 try{
  const first=panelCredentials('https://vault.example/session','vault-token',old);
  assert.equal(await first.verify('Bearer '+recovery),true);
  await first.rotate('Bearer '+old,next);
  assert.equal(await first.verify('Bearer '+recovery),true);
  await first.rotate('Bearer '+recovery,replacement);
  const restarted=panelCredentials('https://vault.example/session','vault-token',old);
  assert.equal(await restarted.verify('Bearer '+recovery),false);
  assert.equal(await restarted.verify('Bearer '+replacement),true);
  assert.equal(JSON.stringify(saved).includes(recovery),false);
  process.env.PANEL_RECOVERY_UNTIL=String(Date.now()-1);
  assert.equal(await panelCredentials('https://vault.example/session','vault-token',old).verify('Bearer '+recovery),false);
 }finally{delete process.env.PANEL_RECOVERY_PASSWORD;delete process.env.PANEL_RECOVERY_UNTIL;mock.restoreAll();}
});
