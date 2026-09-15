import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { processEvent, pgDatabase, type Database } from '../src/infra/postgres.ts';

const migration = await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8');
const integration = { skip: !process.env.MLG_TEST_DATABASE_URL };
// Only a disposable test server. Create an isolated DB for every test, never
// migrate or clean a supplied database. No production credentials in CI.
async function fixture() {
  const url = process.env.MLG_TEST_DATABASE_URL;
  if (!url) throw new Error('MLG_TEST_DATABASE_URL required');
  const admin = new Pool({connectionString:url});
  const name = 'mlg_test_' + randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const dbUrl = new URL(url); dbUrl.pathname = '/'+name;
  let pool = new Pool({connectionString:dbUrl.toString()});
  return {
    get pool(){return pool;},
    async restartClient(){await pool.end(); pool = new Pool({connectionString:dbUrl.toString()});},
    async close(){await pool.end(); await admin.query('DROP DATABASE '+name); await admin.end();}
  };
}
async function setup(db: Pool) {
  await db.query(migration);
  await db.query("INSERT INTO mlg_bot.users VALUES ('admin','Admin'); INSERT INTO mlg_bot.groups VALUES ('g',true); INSERT INTO mlg_bot.admins VALUES ('g','admin','owner');");
  for (let i=0;i<16;i++) await db.query('INSERT INTO mlg_bot.club_pool VALUES ($1,$2)',['g',`Club ${i}`]);
}

test('PostgreSQL real: copa completa, estado relacional, reconexão de cliente e dedup', integration, async () => {
  const f = await fixture(); let db = f.pool;
  try {
    await setup(db); let eventId=0;
    const send = (userId: string,text: string,id = `e${++eventId}`) => processEvent(pgDatabase(db),{id,groupId:'g',userId,name:userId,text,at:Date.now()});
    await send('admin','!novacopa'); await send('admin','1'); await send('u0','!entrar');
    await f.restartClient(); db = f.pool;
    for (let i=1;i<4;i++) await send(`u${i}`,'!entrar');
    for (let i=0;i<3;i++) {
      const m = (await db.query<{code:string;home:string;away:string}>("SELECT * FROM mlg_bot.matches WHERE status='scheduled' ORDER BY code LIMIT 1")).rows[0]!;
      await send(m.home,`!resultado ${m.code} 2x0`);
      await f.restartClient(); db = f.pool;
      await send(m.away,`!confirmar ${m.code}`,`confirm-${i}`);
      const before = (await db.query('SELECT count(*) FROM mlg_bot.outbox')).rows;
      assert.equal((await send(m.away,`!confirmar ${m.code}`,`confirm-${i}`)).duplicate,true);
      assert.deepEqual((await db.query('SELECT count(*) FROM mlg_bot.outbox')).rows,before);
    }
    assert.equal((await db.query<{status:string}>('SELECT status FROM mlg_bot.cups')).rows[0]!.status,'completed');
    assert.equal((await db.query('SELECT * FROM mlg_bot.matches')).rows.length,3);
    assert.equal((await db.query('SELECT DISTINCT club FROM mlg_bot.cup_participants')).rows.length,4);
    assert.ok((await send('u0','!campeoes')).notices.join('').includes('Campeão'));
  } finally { await f.close(); }
});

test('rollback antes de outbox: nada é marcado processado nem inscrito', integration, async () => {
  const f = await fixture(); const db = f.pool;
  try {
    await setup(db);
    const event = {id:'1',groupId:'g',userId:'admin',name:'Admin',at:1,text:'!novacopa'};
    const fail: Database = { transaction: run => pgDatabase(db).transaction(q => run({ query: async <T>(sql:string,values?:unknown[]) => {
      if(sql.includes('INSERT INTO mlg_bot.outbox')) throw new Error('injected storage failure');
      return q.query<T>(sql,values);
    }})) };
    await assert.rejects(processEvent(fail,event),/injected/);
    assert.equal((await db.query('SELECT * FROM mlg_bot.processed_messages')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM mlg_bot.command_drafts')).rows.length,0);
    await processEvent(pgDatabase(db),event);
    assert.equal((await db.query('SELECT * FROM mlg_bot.command_drafts')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM mlg_bot.processed_messages')).rows.length,1);
  } finally { await f.close(); }
});

test('constraints: isolamento, confirmação e clube repetido', integration, async () => {
  const f = await fixture(); const db = f.pool;
  try {
    await setup(db);
    let id=0; const send=(userId:string,text:string)=>processEvent(pgDatabase(db),{id:String(++id),groupId:'g',userId,name:userId,at:id,text});
    await send('admin','!novacopa');await send('admin','1');
    for(let i=0;i<4;i++) await send(`u${i}`,'!entrar');
    await assert.rejects(db.query("UPDATE mlg_bot.cup_participants SET club='same'"),/unique/i);
    const m=(await db.query<{code:string;home:string;away:string}>('SELECT * FROM mlg_bot.matches ORDER BY code LIMIT 1')).rows[0]!;
    await send(m.home,`!resultado ${m.code} 1x0`);
    await assert.rejects(send('stranger',`!confirmar ${m.code}`),/confronto/);
    await assert.rejects(send(m.home,`!confirmar ${m.code}`),/próprio/);
    assert.equal((await db.query<{status:string}>('SELECT status FROM mlg_bot.matches WHERE code=$1',[m.code])).rows[0]!.status,'pending');
    await send(m.away,`!confirmar ${m.code}`);
  } finally { await f.close(); }
});
