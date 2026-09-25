import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { processEvent, pgDatabase, type Database } from '../src/infra/postgres.ts';
import { authStore } from '../src/whatsapp/auth-store.ts';
import { randomBytes } from 'node:crypto';

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
  await db.query(await readFile(new URL('../migrations/002_worker.sql',import.meta.url),'utf8'));
  // Supabase built-in roles exist in production; recreate only NOLOGIN roles in this disposable server.
  await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; END IF; END $$");
  await db.query(await readFile(new URL('../migrations/003_minicamp_gateway.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/004_controls_history.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/010_coach_profiles.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/011_competitions.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/012_competition_templates.sql',import.meta.url),'utf8'));
  await db.query("INSERT INTO mlg_bot.users VALUES ('admin','Admin'); INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES ('g',true,true); INSERT INTO mlg_bot.admins VALUES ('g','admin','owner');");
  for (let i=0;i<16;i++) await db.query('INSERT INTO mlg_bot.club_pool VALUES ($1,$2)',['g',`Club ${i}`]);
}

test('modelos de campeonato ficam no grupo e a Copa conserva nome e sorteio após edição',integration,async()=>{
 const f=await fixture();const db=f.pool;
 try{
  await setup(db);
  const teams=['Brasil','Argentina','Portugal','França'];
  const model=await db.query<{id:string}>("INSERT INTO mlg_bot.competition_templates(group_id,name,team_kind,teams) VALUES('g','Copa do Mundo','seleção',$1) RETURNING id",[teams]);
  const id=model.rows[0]!.id;
  await db.query("UPDATE mlg_bot.groups SET competition_name='Copa do Mundo',team_kind='seleção',active_template_id=$1 WHERE id='g'",[id]);
  await db.query("DELETE FROM mlg_bot.club_pool WHERE group_id='g'");
  for(const team of teams)await db.query("INSERT INTO mlg_bot.club_pool(group_id,name) VALUES('g',$1)",[team]);
  let seq=0;const send=(who:string,text:string)=>processEvent(pgDatabase(db),{id:'template-'+ ++seq,groupId:'g',userId:who,name:who,text,at:Date.now()+seq});
  assert.match((await send('admin','!novacopa')).notices[0]!,/COPA DO MUNDO/);
  await send('admin','!formato 4');for(let i=0;i<4;i++)await send('j'+i,'!entrar');
  const cup=await db.query<{competition_name:string;team_kind:string}>("SELECT competition_name,team_kind FROM mlg_bot.cups WHERE group_id='g'");
  assert.deepEqual(cup.rows[0],{competition_name:'Copa do Mundo',team_kind:'seleção'});
  assert.deepEqual((await db.query<{club:string}>("SELECT club FROM mlg_bot.cup_participants ORDER BY club")).rows.map(x=>x.club).sort(),[...teams].sort());
  await db.query("UPDATE mlg_bot.competition_templates SET name='Copa América',teams=ARRAY['Chile','México','Uruguai','Peru'] WHERE id=$1",[id]);
  assert.equal((await db.query<{name:string}>("SELECT competition_name AS name FROM mlg_bot.cups")).rows[0]!.name,'Copa do Mundo');
  await db.query("INSERT INTO mlg_bot.groups(id,authorized) VALUES('other',true)");
  await assert.rejects(db.query("UPDATE mlg_bot.groups SET active_template_id=$1 WHERE id='other'",[id]));
 }finally{await f.close();}
});

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
    assert.match((await send('u0','!campeoes')).notices.join(''),/campe[ãõ]/i);
  } finally { await f.close(); }
});

test('sessão: gravação cifrada, recuperação de chaves e remoção', integration, async () => {
  const f=await fixture(); const db=f.pool;
  try {
    await setup(db);const key=randomBytes(32);
    const first=await authStore(db,'test',key);await first.save();
    await first.state.keys.set({'lid-mapping':{'test-lid':'test-pn'}});
    const second=await authStore(db,'test',key);
    assert.ok(Buffer.from(first.state.creds.noiseKey.private).equals(Buffer.from(second.state.creds.noiseKey.private)));
    assert.equal((await second.state.keys.get('lid-mapping',['test-lid']))['test-lid'],'test-pn');
    await assert.rejects(authStore(db,'test',randomBytes(32)));
    await second.state.keys.set({'lid-mapping':{'test-lid':null}});
    assert.equal((await second.state.keys.get('lid-mapping',['test-lid']))['test-lid'],undefined);
  }finally {await f.close();}
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
    await send(m.home,`!resultado ${m.code} 0x1`);
    await assert.rejects(send('stranger',`!confirmar ${m.code}`),/confronto/);
    await assert.rejects(send(m.home,`!confirmar ${m.code} 1x0`),/Placar diferente/);
    assert.equal((await db.query<{status:string}>('SELECT status FROM mlg_bot.matches WHERE code=$1',[m.code])).rows[0]!.status,'pending');
    await send(m.home,`!confirmar ${m.code}`);
    const other=(await db.query<{code:string;home:string}>("SELECT code,home FROM mlg_bot.matches WHERE status='scheduled' ORDER BY code LIMIT 1")).rows[0]!;
    await send(other.home,`!resultado ${other.code} 2x0`);
    await send(other.home,`!confirmar ${other.code}`);
    const confirmed=(await db.query<{reason:string;confirmed_by:string;status:string}>('SELECT reason,confirmed_by,status FROM mlg_bot.match_results WHERE match_code=$1',[other.code])).rows[0]!;
    assert.equal(confirmed.confirmed_by,other.home);
    assert.equal(confirmed.status,'confirmed');
    assert.match(confirmed.reason,/próprio jogador/);
  } finally { await f.close(); }
});

test('cadastros persistem com auditoria, autorização e rollback sob papel gateway',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);await f.pool.query("INSERT INTO mlg_bot.users VALUES ('coach','Original');");
  const base=pgDatabase(f.pool);const gateway:Database={transaction:run=>base.transaction(async q=>{await q.query('SET LOCAL ROLE mlg_bot_gateway');return run(q);})};
  const event={id:'profile',groupId:'g',userId:'admin',name:'ADM',at:1,text:'!registrarid coach Nome Oficial'};
  await processEvent(gateway,event);assert.equal((await processEvent(gateway,event)).duplicate,true);
  assert.equal((await f.pool.query('SELECT count(*) FROM mlg_bot.coach_profiles')).rows[0].count,'1');
  assert.equal((await f.pool.query('SELECT cup_id FROM mlg_bot.audit_logs')).rows[0].cup_id,null);
  await f.restartClient();const res=await processEvent(pgDatabase(f.pool),{...event,id:'career',userId:'coach',name:'Nome WhatsApp',text:'!carreira'});assert.match(res.notices[0]!,/Nome Oficial/);
  await assert.rejects(processEvent(pgDatabase(f.pool),{...event,id:'unauthorized',userId:'coach',text:'!associarid coach Alterado'}),/Somente ADM/);
  const fail:Database={transaction:run=>pgDatabase(f.pool).transaction(q=>run({query:async<T>(sql:string,args?:unknown[])=>{if(sql.includes('INSERT INTO mlg_bot.outbox'))throw Error('storage failure');return q.query<T>(sql,args);}}))};
  await assert.rejects(processEvent(fail,{...event,id:'rollback',text:'!associarid coach Alterado'}),/storage failure/);
  assert.equal((await f.pool.query('SELECT display_name FROM mlg_bot.coach_profiles')).rows[0].display_name,'Nome Oficial');
 }finally{await f.close();}
});

test('gateway real: menção, bloqueio de comandos internos e sincronização sem unir contas',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES ('100@g.us',true,true); INSERT INTO mlg_bot.admins VALUES ('100@g.us','admin','owner'); INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES ('100@s.whatsapp.net','admin');");
  const {createHash,webcrypto}=await import('node:crypto');const header='Bearer synthetic-test-token';
  const source=(await readFile(new URL('../deploy/minicamp-gateway.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('__DIGEST__',createHash('sha256').update(header).digest('hex'));
  let handler:((req:Request)=>Promise<Response>)|undefined;
  const factory=new Function('Pool','randomUUID','pgDatabase','processEvent','minicampClubs','Deno','crypto',source);
  const client=f.pool;
  factory(class {constructor(){return client;}},randomUUID,pgDatabase,processEvent,[],{env:{get:()=>''},serve:(fn:typeof handler)=>{handler=fn;}},webcrypto);
  let serial=0;
  const send=async(text:string,targets?:string[][],aliases=['100@s.whatsapp.net'])=>handler!(new Request('https://example.invalid',{method:'POST',headers:{authorization:header},body:JSON.stringify({action:'event',event:{group:'100@g.us',aliases,targets,id:String(++serial),name:'Test',text}})}));
  assert.equal((await send('!registrar Técnico | @conta',[['200@lid','200@s.whatsapp.net']])).status,200);
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.coach_profiles WHERE group_id='100@g.us'")).rows[0].display_name,'Técnico');
  assert.equal((await send('!registrarid admin Forged')).status,503);
  assert.equal((await send('!associar Alterado | @conta',[['200@lid']],['300@s.whatsapp.net'])).status,200);
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.coach_profiles WHERE group_id='100@g.us'")).rows[0].display_name,'Técnico');
  assert.equal((await send('!carreira @conta',[['200@lid']])).status,200);
  assert.equal((await send('!jornada @conta',[['200@lid']])).status,200);
  assert.match((await f.pool.query("SELECT body FROM mlg_bot.outbox WHERE body LIKE '🎮 CARREIRA%' ORDER BY id DESC LIMIT 1")).rows[0].body,/Técnico/);
  const before=await f.pool.query('SELECT jid,user_id FROM mlg_bot.wa_identities ORDER BY jid');
  assert.equal((await send('!sincronizarcontas',[['200@lid','300@s.whatsapp.net'],['200@lid','201@s.whatsapp.net']])).status,200);
  const after=await f.pool.query('SELECT jid,user_id FROM mlg_bot.wa_identities ORDER BY jid');
  assert.equal(after.rows.length,before.rows.length+1);
  for(const old of before.rows)assert.deepEqual(after.rows.find(r=>r.jid===old.jid),old);
  assert.match((await f.pool.query("SELECT body FROM mlg_bot.outbox WHERE body LIKE '%CONEXÕES%' ORDER BY id DESC LIMIT 1")).rows[0].body,/1 conflitos/);
 }finally{await f.close();}
});
