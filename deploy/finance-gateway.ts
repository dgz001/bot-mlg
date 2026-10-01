// @ts-nocheck — prepared Edge bundle, not deployed or enabled this season.
import {Pool} from 'npm:pg@8.23.0';
import {financeEvent,financePoll,financeAck} from './store.ts';
const EXPECTED_DIGEST='__DIGEST__';
const pool=new Pool({connectionString:Deno.env.get('SUPABASE_DB_URL'),max:2,connectionTimeoutMillis:8000});
const database={transaction:async run=>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('SET LOCAL ROLE mlg_finance_gateway');
  const result=await run({query:async(sql,values)=>({rows:(await client.query(sql,values)).rows})});
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}};
Deno.serve(async request=>{
 const authorization=request.headers.get('authorization')??'';
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(authorization)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(digest!==EXPECTED_DIGEST)return new Response('Unauthorized',{status:401});
 // This independent deployment gate prevents registration and payments until
 // the next-season release, even if the worker was configured accidentally.
 if(Deno.env.get('FINANCE_ENABLED')!=='true')return Response.json({error:'FINANCE_NOT_RELEASED'},{status:503});
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 try{
  const raw=await request.text();if(raw.length>12000)return new Response('Too large',{status:413});
  const body=JSON.parse(raw);let result;
  if(body.action==='health')result=await database.transaction(async q=>{await q.query('SELECT 1 FROM mlg_finance.seasons LIMIT 1');return {database:true};});
  else if(body.action==='event')result=await financeEvent(database,body.event);
  else if(body.action==='poll')result=await financePoll(database);
  else if(body.action==='ack'){
   const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
   if(!uuid.test(body.id)||!uuid.test(body.lease)||typeof body.sent!=='boolean')return new Response('Invalid acknowledgement',{status:400});
   result=await financeAck(database,body.id,body.lease,body.sent);
  }else return new Response('Unsupported action',{status:400});
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'FINANCE_UNAVAILABLE'},{status:503,headers:{'Cache-Control':'no-store'}});}
});
