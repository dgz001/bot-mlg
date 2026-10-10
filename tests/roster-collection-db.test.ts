import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {Pool} from 'pg';
test('roster collection closure, access rules and immutable delivered progress',{skip:!process.env.MLG_TEST_DATABASE_URL},async()=>{
 const root=new Pool({connectionString:process.env.MLG_TEST_DATABASE_URL}),name='rosters_'+randomUUID().replaceAll('-','');await root.query('create database '+name);const url=new URL(process.env.MLG_TEST_DATABASE_URL!);url.pathname='/'+name;const db=new Pool({connectionString:url.toString()});
 try{
  await db.query(await readFile(new URL('./fixtures/mlg-window-integrity-base.sql',import.meta.url),'utf8'));
  await db.query('create table public.whatsapp_market_club_directory(club_id uuid primary key,phone text)');
  await db.query(await readFile(new URL('./fixtures/mlg-roster-collection.sql',import.meta.url),'utf8'));
  await assert.rejects(()=>db.query("select public.admin_configure_roster_collection(true,'12345@g.us',1)"),/Somente ADMs/);
  const a=randomUUID();await db.query('insert into auth.users values($1);',[a]);await db.query('insert into public.admin_users values($1)',[a]);const c=await db.connect();await c.query("select set_config('mlg_test.actor',$1,false)",[a]);
  await db.query(await readFile(new URL('./fixtures/mlg-roster-readiness.sql',import.meta.url),'utf8'));
  await assert.rejects(()=>c.query("select public.admin_configure_roster_collection(true,'12345@g.us',1)"),/Atualize o bot/);
  await db.query('update public.roster_collection_settings set bot_seen=clock_timestamp()');
  await c.query("select public.admin_configure_roster_collection(true,'12345@g.us',1)");await assert.rejects(()=>c.query("select public.admin_configure_roster_collection(true,'12345@g.us',1)"),/mudou/);
  const ids:string[]=[];for(let i=0;i<25;i++){const id=randomUUID();ids.push(id);await c.query('insert into public.clubs(id,name,balance) values($1,$2,0)',[id,'Club '+i]);await c.query('insert into public.whatsapp_market_club_directory values($1,$2)',[id,'556599340'+String(i).padStart(4,'0')]);}
  await c.query('insert into public.market_windows(market_cycle_id) values($1)',[randomUUID()]);await c.query('update public.market_windows set transfer_window_open=false');assert.equal((await c.query('select count(*) from public.roster_collection_runs')).rows[0].count,'0');
  await c.query('update public.market_windows set trade_window_open=false');const run=(await c.query('select id from public.roster_collection_runs')).rows[0].id;await c.query('update public.market_windows set trade_window_open=false');assert.equal((await c.query('select count(*) from public.roster_collection_runs')).rows[0].count,'1');
  const config=(await c.query('select private.roster_collection_config() config')).rows[0].config;assert.equal(config.directory.length,25);assert.equal(config.opened,false);
  await c.query('select private.roster_collection_progress($1)',[{run,club:ids[0],status:'delivered'}]);await c.query('select private.roster_collection_progress($1)',[{run,club:ids[0],status:'incomplete'}]);assert.equal((await c.query('select status from public.roster_collection_deliveries')).rows[0].status,'delivered');
  assert.equal((await c.query("select has_function_privilege('anon','private.roster_collection_config()','execute') allowed")).rows[0].allowed,false);assert.equal((await c.query("select has_table_privilege('anon','public.roster_collection_deliveries','select') allowed")).rows[0].allowed,false);c.release();
 }finally{await db.end();await root.query('drop database '+name);await root.end();}
});
