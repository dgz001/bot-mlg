import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { processEvent, pgDatabase, checkpointCup, canonicalCheckpoint, cupDraw, cupRoster, cupRerollTeam, type Database } from '../src/infra/postgres.ts';
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
  await db.query(await readFile(new URL('../migrations/013_mixed_draw_pools.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/014_cup_checkpoints.sql',import.meta.url),'utf8'));
  await db.query("INSERT INTO mlg_bot.users VALUES ('admin','Admin'); INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES ('g',true,true); INSERT INTO mlg_bot.admins VALUES ('g','admin','owner');");
  for (let i=0;i<16;i++) await db.query('INSERT INTO mlg_bot.club_pool VALUES ($1,$2)',['g',`Club ${i}`]);
}

test('nome confirmado pelo ADM persiste entre grupos e reinícios sem depender do apelido do WhatsApp',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  await f.pool.query("INSERT INTO mlg_bot.users(id,display_name) VALUES('u0','Apelido temporário'); INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES('g2',true,true); INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES('g2','admin','admin')");
  for(let i=0;i<16;i++)await f.pool.query('INSERT INTO mlg_bot.club_pool VALUES($1,$2)',['g2',`Equipe ${i}`]);
  let index=0;const send=(groupId:string,userId:string,text:string)=>processEvent(pgDatabase(f.pool),{id:'name-'+ ++index,groupId,userId,name:userId==='u0'?'Apelido novo':userId,text,at:Date.now()+index});
  await send('g','admin','!cadastrarid u0 @Maria Souza');
  await send('g2','admin','!novacopa');await send('g2','admin','!formato 4');
  await f.restartClient();
  assert.match((await send('g2','u0','!entrar')).notices[0]!,/Maria Souza/);
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.coach_profiles WHERE group_id='g2' AND user_id='u0'")).rows[0].display_name,'Maria Souza');
  await send('g2','admin','!editarid u0 @Maria da Silva');
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.coach_profiles WHERE group_id='g' AND user_id='u0'")).rows[0].display_name,'Maria da Silva');
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.users WHERE id='u0'")).rows[0].display_name,'Maria da Silva');
  assert.match((await send('g2','u0','!participantes')).notices[0]!,/Maria da Silva/);
 }finally{await f.close();}
});

test('três inscrições concorrentes ocupam posições únicas e duas confirmações avançam uma vez',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  const db=pgDatabase(f.pool);let id=0;
  const send=(userId:string,text:string)=>processEvent(db,{id:'race-'+ ++id,groupId:'g',userId,name:userId,text,at:Date.now()});
  await send('admin','!novacopa');await send('admin','!formato 16');
  const arrivals=await Promise.all(['u0','u1','u2'].map(who=>send(who,'!entrar')));
  assert.equal(arrivals.filter(r=>!r.duplicate).length,3);
  const first=await f.pool.query<{user_id:string;position:number}>("SELECT user_id,position FROM mlg_bot.cup_participants ORDER BY position");
  assert.deepEqual(first.rows.map(p=>p.position),[0,1,2]);
  assert.deepEqual(new Set(first.rows.map(p=>p.user_id)),new Set(['u0','u1','u2']));
  for(let i=3;i<16;i++)await send('u'+i,'!entrar');
  const match=(await f.pool.query<{code:string;home:string;away:string}>("SELECT code,home,away FROM mlg_bot.matches WHERE round=0 ORDER BY position LIMIT 1")).rows[0]!;
  await send(match.home,`!resultado ${match.code} 3x2`);
  const results=await Promise.all([send(match.home,`!confirmar ${match.code}`),send(match.away,`!confirmar ${match.code}`)]);
  assert.equal(results.filter(r=>r.notices.join('\n').includes('CHAVE ATUALIZADA')).length,1);
  assert.equal(results.filter(r=>r.notices.join('\n').includes('JÁ CONFIRMADO')).length,1);
  const registered=await f.pool.query<{total:number;winner:string;status:string}>("SELECT count(r.revision)::int AS total,max(m.winner) AS winner,max(m.status) AS status FROM mlg_bot.matches m JOIN mlg_bot.match_results r ON r.match_code=m.code WHERE m.code=$1 GROUP BY m.code",[match.code]);
  assert.equal(registered.rows[0]?.total,1);assert.equal(registered.rows[0]?.status,'confirmed');
 }finally{await f.close();}
});

test('refazer sorteio preserva participantes, códigos e checkpoints e bloqueia após placar',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES('central',true,true); INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES('central','admin','admin'); INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES('123@s.whatsapp.net','admin')");
  let index=0;const send=(userId:string,text:string)=>processEvent(pgDatabase(f.pool),{id:'draw-'+ ++index,groupId:'g',userId,name:userId,text,at:Date.now()+index});
  await send('admin','!novacopa');await send('admin','!formato 4');
  for(let i=0;i<4;i++)await send('u'+i,'!entrar');
  const db=pgDatabase(f.pool);const request={group:'g',controlGroup:'central',actorAliases:['123@s.whatsapp.net']};
  const preview=await cupDraw(db,request);assert.equal(preview.matches?.length,2);
  const denied=await cupDraw(db,{...request,actorAliases:['999@s.whatsapp.net']});assert.match(denied.error!,/ADMs/);
  const stale=await cupDraw(db,{...request,mode:'completo',expected:'0'.repeat(64),reason:'Corrigir o sorteio inicial'});assert.match(stale.error!,/mudou/);
  const beforeCodes=preview.matches!.map(m=>m.code);const beforeTeams=preview.participants!.map(p=>p.club).sort();
  const result=await cupDraw(db,{...request,mode:'completo',expected:preview.fingerprint,reason:'Corrigir o sorteio inicial'});assert.equal(result.changed,true);
  const current=await cupDraw(db,request);assert.deepEqual(current.matches!.map(m=>m.code),beforeCodes);assert.deepEqual(current.participants!.map(p=>p.club).sort(),beforeTeams);
  assert.notEqual(current.fingerprint,preview.fingerprint);
  const checkpoints=await f.pool.query('SELECT event_id FROM mlg_bot.cup_checkpoints WHERE cup_id=$1 ORDER BY id DESC LIMIT 2',[preview.cupId]);assert.match(checkpoints.rows[0].event_id,/-after$/);assert.match(checkpoints.rows[1].event_id,/-before$/);
  const match=current.matches![0]!;await send(match.home,`!resultado ${match.code} 2x1`);
  const blocked=await cupDraw(db,request);assert.match(blocked.error!,/Sorteio bloqueado/);
  const announced=await f.pool.query("SELECT body FROM mlg_bot.outbox WHERE message_id LIKE 'panel-%' ORDER BY id DESC LIMIT 1");assert.match(announced.rows[0].body,/SORTEIO ATUALIZADO/);
 }finally{await f.close();}
});

test('sorteio individual troca só seleções livres, preserva placares e bloqueia repetição',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  await f.pool.query("INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES('123@s.whatsapp.net','admin')");
  let serial=0;const db=pgDatabase(f.pool);
  const send=(userId:string,text:string)=>processEvent(db,{id:'reroll-'+ ++serial,groupId:'g',userId,name:userId,text,at:Date.now()+serial});
  await send('admin','!novacopa');await send('admin','!formato 4');
  for(let i=0;i<4;i++)await send('u'+i,'!entrar');
  const cup=(await f.pool.query('SELECT id FROM mlg_bot.cups WHERE group_id=$1 AND status=$2',['g','playing'])).rows[0].id;
  await f.pool.query("INSERT INTO mlg_bot.club_pool(group_id,name) VALUES('g','Ucrânia'),('g','Rússia')");
  await f.pool.query('UPDATE mlg_bot.cup_participants SET club=NULL WHERE cup_id=$1 AND user_id=ANY($2::text[])',[cup,['u0','u1']]);
  await f.pool.query("UPDATE mlg_bot.cup_participants SET club=CASE user_id WHEN 'u0' THEN 'Ucrânia' ELSE 'Rússia' END WHERE cup_id=$1 AND user_id IN ('u0','u1')",[cup]);
  for(const i of [0,1])await f.pool.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2)',[`${200+i}@s.whatsapp.net`,`u${i}`]);
  const match=(await f.pool.query<{code:string;home:string;away:string}>("SELECT code,home,away FROM mlg_bot.matches WHERE cup_id=$1 AND round=0 AND (home='u0' OR away='u0')",[cup])).rows[0]!;
  await send(match.home,`!resultado ${match.code} 3x1`);await send(match.home,`!confirmar ${match.code}`);
  // Recording a result synchronizes stored profile names. Set these fixture
  // names afterwards so the ambiguity check sees the intended participants.
  await f.pool.query("UPDATE mlg_bot.cup_participants SET display_name=CASE user_id WHEN 'u0' THEN 'Samuel' WHEN 'u1' THEN 'Rafael' WHEN 'u2' THEN 'Alex Junior' ELSE 'Alex Silva' END WHERE cup_id=$1",[cup]);
  const before=(await f.pool.query('SELECT code,round,position,home,away,winner,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY code',[cup])).rows;
  const base={group:'g',actorAliases:['123@s.whatsapp.net'],reason:'Seleção indisponível no jogo'};
  assert.match((await cupRerollTeam(db,{...base,actorAliases:['999@s.whatsapp.net'],targetAliases:['200@s.whatsapp.net'],messageId:'deny'})).error!,/ADMs/);
  assert.match((await cupRerollTeam(db,{...base,targetName:'Alex',messageId:'ambiguous'})).error!,/mais de um participante/);
  const first=await cupRerollTeam(db,{...base,targetName:'samuel',messageId:'change-1'});
  assert.equal(first.oldTeam,'Ucrânia');assert.ok(first.newTeam&&!['Ucrânia','Rússia'].includes(first.newTeam));
  assert.equal((await cupRerollTeam(db,{...base,targetName:'Samuel',messageId:'change-1'})).duplicate,true);
  const second=await cupRerollTeam(db,{...base,targetName:'Rafael',messageId:'change-2'});
  assert.equal(second.oldTeam,'Rússia');assert.ok(second.newTeam&&!['Ucrânia','Rússia',first.newTeam].includes(second.newTeam));
  assert.deepEqual((await f.pool.query('SELECT code,round,position,home,away,winner,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY code',[cup])).rows,before);
  assert.equal((await f.pool.query('SELECT count(*)::int AS total FROM mlg_bot.match_results WHERE match_code=$1',[match.code])).rows[0].total,1);
  const active=(await f.pool.query('SELECT user_id,club FROM mlg_bot.cup_participants WHERE cup_id=$1',[cup])).rows;
  assert.equal(active.find(p=>p.user_id==='u0')?.club,first.newTeam);assert.equal(active.find(p=>p.user_id==='u1')?.club,second.newTeam);
  assert.equal((await f.pool.query("SELECT count(*)::int AS total FROM mlg_bot.audit_logs WHERE cup_id=$1 AND action='team-reroll'",[cup])).rows[0].total,2);
  assert.equal((await f.pool.query("SELECT count(*)::int AS total FROM mlg_bot.cup_checkpoints WHERE cup_id=$1 AND event_id LIKE 'team-reroll-%'",[cup])).rows[0].total,4);
 }finally{await f.close();}
});

test('central inclui última vaga com sorteio e substitui sem mudar código ou seleção',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES('central',true,true); INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES('central','admin','admin'); INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES('123@s.whatsapp.net','admin')");
  let id=0;const send=(userId:string,text:string)=>processEvent(pgDatabase(f.pool),{id:'roster-'+ ++id,groupId:'g',userId,name:userId,text,at:Date.now()+id});
  await send('admin','!novacopa');await send('admin','!formato 4');for(let i=0;i<3;i++)await send('u'+i,'!entrar');
  const db=pgDatabase(f.pool),request={group:'g',controlGroup:'central',actorAliases:['123@s.whatsapp.net']};
  const first=await cupRoster(db,request);assert.equal(first.status,'open');assert.equal(first.participants?.length,3);
  const included=await cupRoster(db,{...request,change:'incluir',targetAliases:['5511000000001@s.whatsapp.net'],targetName:'Lia',expected:first.fingerprint,reason:'ADM liberou a última vaga'});
  assert.equal(included.status,'playing');assert.equal(included.participants?.length,4);
  const before=await cupRoster(db,request);const match=(await f.pool.query<{code:string;home:string;away:string}>('SELECT code,home,away FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY code LIMIT 1',[before.cupId])).rows[0]!;
  const index=before.participants!.findIndex(p=>p.user_id===match.home)+1;const club=before.participants![index-1]!.club;
  const changed=await cupRoster(db,{...request,change:'trocar',position:index,targetAliases:['5511000000002@s.whatsapp.net'],targetName:'Novo jogador',expected:before.fingerprint,reason:'O titular precisou sair'});
  assert.equal(changed.changed,true);assert.equal(changed.participants![index-1]!.club,club);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM mlg_bot.matches WHERE cup_id=$1',[before.cupId])).rows[0].count,2);
  const active=await cupRoster(db,request);assert.notEqual(active.fingerprint,before.fingerprint);
  const newMatch=(await f.pool.query<{code:string;home:string}>('SELECT code,home FROM mlg_bot.matches WHERE code=$1',[match.code])).rows[0]!;
  assert.equal(newMatch.code,match.code);assert.notEqual(newMatch.home,match.home);
  await send(newMatch.home,`!resultado ${newMatch.code} 2x1`);
  const blocked=await cupRoster(db,{...request,change:'trocar',position:index,targetAliases:['5511000000003@s.whatsapp.net'],targetName:'Terceiro',expected:(await cupRoster(db,request)).fingerprint,reason:'Mais uma troca solicitada'});
  assert.match(blocked.error!,/antes do primeiro placar/);
 }finally{await f.close();}
});

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
    const checkpoints=await db.query<{state:unknown;sha256:string}>('SELECT state,sha256 FROM mlg_bot.cup_checkpoints ORDER BY id');
    assert.equal(checkpoints.rows.length,11); // creation, four entrants, six result/confirmation events
    for(const item of checkpoints.rows)assert.equal((await import('node:crypto')).createHash('sha256').update(canonicalCheckpoint(item.state)).digest('hex'),item.sha256);
    assert.equal((checkpoints.rows.at(-1)!.state as {cup:{status:string}}).cup.status,'completed');
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
    assert.equal((await db.query('SELECT * FROM mlg_bot.cup_checkpoints')).rows.length,0);
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
  const {memberCommand}=await import('../src/minicamp/member-commands.ts');
  const factory=new Function('Pool','randomUUID','pgDatabase','processEvent','checkpointCup','cupRerollTeam','minicampClubs','memberCommand','Deno','crypto',source);
  const client=f.pool;
  factory(class {constructor(){return client;}},randomUUID,pgDatabase,processEvent,checkpointCup,cupRerollTeam,[],memberCommand,{env:{get:()=>''},serve:(fn:typeof handler)=>{handler=fn;}},webcrypto);
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
  await f.pool.query("INSERT INTO mlg_bot.club_pool(group_id,name) SELECT '100@g.us',name FROM mlg_bot.club_pool WHERE group_id='g'");
  const call=async(action:string,extra:Record<string,unknown>={})=>{
   const response=await handler!(new Request('https://example.invalid',{method:'POST',headers:{authorization:header},body:JSON.stringify({action,group:'100@g.us',...extra})}));
   assert.equal(response.status,200);return response.json() as Promise<Record<string,unknown>>;
  };
  assert.equal((await call('control-check',{aliases:['100@s.whatsapp.net']})).allowed,true);
  assert.equal((await call('control-check',{aliases:['300@s.whatsapp.net']})).allowed,false);
  assert.equal((await call('cup-open',{size:4})).edition,1);
  assert.match(String((await call('cup-open',{size:4})).error),/Já existe/);
  const opened=await call('templates-list');
  assert.equal((opened.activeCup as {checkpointCount:number}).checkpointCount,1);
  assert.ok((opened.activeCup as {checkpointAt:number}).checkpointAt);
  assert.equal((await call('cup-cancel',{reason:'Edição cancelada por manutenção'})).edition,1);
  const snapshots=await f.pool.query<{state:{cup:{status:string}};sha256:string}>("SELECT state,sha256 FROM mlg_bot.cup_checkpoints WHERE group_id='100@g.us' ORDER BY id");
  assert.deepEqual(snapshots.rows.map(r=>r.state.cup.status),['open','cancelled']);
  for(const point of snapshots.rows)assert.equal(createHash('sha256').update(canonicalCheckpoint(point.state)).digest('hex'),point.sha256);
  const cancelledList=await call('templates-list');
  assert.equal(cancelledList.activeCup,null);
  assert.equal(cancelledList.nextEdition,1);
  assert.equal((cancelledList.recentCups as {status:string;edition:string}[])[0]?.status,'cancelled');
  const editionId=randomUUID();
  await f.pool.query("INSERT INTO mlg_bot.users(id,display_name) VALUES ('winner','Vencedor') ON CONFLICT DO NOTHING");
  await f.pool.query("INSERT INTO mlg_bot.cups(id,group_id,created_by,created_at,size,status,competition_name,team_kind) VALUES($1,'100@g.us','admin',$2,4,'open','Copa de Teste','clube')",[editionId,Date.now()+1]);
  await f.pool.query("INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position) VALUES($1,'winner','Vencedor',0)",[editionId]);
  await f.pool.query("UPDATE mlg_bot.cups SET status='completed',champion='winner',completed_at=$2 WHERE id=$1",[editionId,Date.now()+2]);
  const editions=await call('templates-list');
  assert.equal((editions.recentCups as {id:string;edition:string}[]).find(c=>c.id===editionId)?.edition,'1');
  assert.equal((await call('cup-void',{edition:1,reason:'Correção da edição de teste'})).edition,1);
  assert.equal((await f.pool.query('SELECT status FROM mlg_bot.cups WHERE id=$1',[editionId])).rows[0].status,'cancelled');
  assert.equal((await call('templates-list')).nextEdition,1);
  assert.equal((await call('cup-open',{size:4,proposal:{name:'Copa Administração MLG',teamKind:'seleção',teams:['Brasil','França','Portugal','Argentina']}})).edition,1);
  const updated=await f.pool.query<{competition_name:string;team_kind:string;teams:string}>("SELECT g.competition_name,g.team_kind,(SELECT string_agg(name,', ' ORDER BY name) FROM mlg_bot.club_pool WHERE group_id=g.id) AS teams FROM mlg_bot.groups g WHERE g.id='100@g.us'");
  assert.equal(updated.rows[0]!.competition_name,'Copa Administração MLG');
  assert.equal(updated.rows[0]!.team_kind,'seleção');
  assert.equal(updated.rows[0]!.teams,'Argentina, Brasil, França, Portugal');
  assert.match(String((await call('cup-open',{size:4,proposal:{name:'Outra Copa MLG',teamKind:'clube',teams:['Time A','Time B','Time C','Time D']}})).error),/Já existe/);
  assert.equal((await f.pool.query("SELECT competition_name FROM mlg_bot.groups WHERE id='100@g.us'")).rows[0].competition_name,'Copa Administração MLG');
 }finally{await f.close();}
});
