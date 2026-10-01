import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { processEvent, autoConfirmDue, pgDatabase, checkpointCup, canonicalCheckpoint, cupDraw, cupRoster, cupRerollTeam, type Database } from '../src/infra/postgres.ts';
import { authStore } from '../src/whatsapp/auth-store.ts';
import { randomBytes } from 'node:crypto';
// @ts-ignore The Edge bundle uses runtime JavaScript without declaration files.
import {guestOpen,guestEvent,guestAutoConfirm,guestArchive,guestStandings,guestFixtures,seededBracket} from '../deploy/guest-competition.ts';

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
  await db.query(await readFile(new URL('../migrations/006_withdrawal_permission.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/010_coach_profiles.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/011_competitions.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/012_competition_templates.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/013_mixed_draw_pools.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/014_cup_checkpoints.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/015_member_blocks.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/016_progressive_bracket.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/017_cup_setup.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/018_season_reset_permissions.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/019_admin_scopes.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/020_loan_groups.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/021_loan_invitations.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/022_guest_competitions.sql',import.meta.url),'utf8'));
  await db.query(await readFile(new URL('../migrations/023_guest_hybrid.sql',import.meta.url),'utf8'));
  await db.query("INSERT INTO mlg_bot.users VALUES ('admin','Admin'); INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES ('g',true,true); INSERT INTO mlg_bot.admins VALUES ('g','admin','owner');");
  for (let i=0;i<16;i++) await db.query('INSERT INTO mlg_bot.club_pool VALUES ($1,$2)',['g',`Club ${i}`]);
}

async function guestGateway(pool:Pool) {
 const {createHash,webcrypto}=await import('node:crypto');
 const {memberCommand}=await import('../src/minicamp/member-commands.ts');
 const header='Bearer synthetic-guest-test-token';
 const source=(await readFile(new URL('../deploy/minicamp-gateway.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('__DIGEST__',createHash('sha256').update(header).digest('hex'));
 let handler:((request:Request)=>Promise<Response>)|undefined;
 const factory=new Function('Pool','randomUUID','pgDatabase','processEvent','autoConfirmDue','checkpointCup','cupDraw','cupRoster','cupRerollTeam','minicampClubs','memberCommand','guestOpen','guestEvent','guestAutoConfirm','guestArchive','Deno','crypto',source);
 factory(class {constructor(){return pool;}},randomUUID,pgDatabase,processEvent,autoConfirmDue,checkpointCup,cupDraw,cupRoster,cupRerollTeam,[],memberCommand,guestOpen,guestEvent,guestAutoConfirm,guestArchive,{env:{get:()=>''},serve:(fn:typeof handler)=>{handler=fn;}},webcrypto);
 return async(body:Record<string,unknown>):Promise<any>=>{
  const response=await handler!(new Request('https://example.invalid',{method:'POST',headers:{authorization:header},body:JSON.stringify(body)}));
  assert.equal(response.status,200);return response.json();
 };
}

test('modalidade mista forma chave dos oito melhores e protege resultados posteriores',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);const group='270@g.us';
  await f.pool.query('INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES($1,true,true)',[group]);
  await f.pool.query("INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,'admin','admin')",[group]);
  await f.pool.query("INSERT INTO mlg_bot.users(id,display_name) VALUES ('mod1','Mod 1'),('mod2','Mod 2'); INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES ('g','mod1','admin'),('g','mod2','admin');");
  const db=pgDatabase(f.pool),teams=Array.from({length:9},(_,i)=>'Clube '+i);
  assert.equal((await guestOpen(db,{group,name:'Liga e mata-mata',mode:'misto',legs:1,size:9,qualifiers:8,teams})).opened,true);
  assert.rejects(()=>guestOpen(db,{group:'271@g.us',name:'Invalida',mode:'misto',legs:1,size:8,qualifiers:8,teams}),/Invalid guest competition/);
  const identity=async(q:any,aliases:string[])=>{const user=aliases[0];await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING',[user]);return user;};
  let serial=0;const event=(user:string,text:string)=>guestEvent(db,{group,aliases:[user],messageId:'hybrid-'+ ++serial,name:user,text},identity);
  for(let i=0;i<9;i++)await event('p'+i,'!entrar');
  const cup=(await f.pool.query('SELECT * FROM mlg_bot.guest_competitions WHERE group_id=$1',[group])).rows[0];
  const first=(await f.pool.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 ORDER BY code LIMIT 1',[cup.id])).rows[0];
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM mlg_bot.guest_matches WHERE cup_id=$1',[cup.id])).rows[0].n,36);
  const league=(await f.pool.query('SELECT code FROM mlg_bot.guest_matches WHERE cup_id=$1 ORDER BY code',[cup.id])).rows;
  const moderators=['admin','mod1','mod2'];let action=0;
  const force=(code:number,score='2x0',reason='revisão oficial da liga')=>event(moderators[action++%moderators.length]!,`!forcarresultado ${code} ${score} ${reason}`);
  for(const m of league)await force(m.code);
  const table=guestStandings((await f.pool.query('SELECT * FROM mlg_bot.guest_players WHERE cup_id=$1',[cup.id])).rows,(await f.pool.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 AND round<9',[cup.id])).rows);
  let knockout=(await f.pool.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 AND round=9 ORDER BY position,leg',[cup.id])).rows;
  assert.equal(knockout.length,4);
  const seeds=seededBracket(8);
  for(let i=0;i<4;i++)assert.deepEqual([knockout[i].home,knockout[i].away],[table[seeds[i*2]!-1]!.id,table[seeds[i*2+1]!-1]!.id]);
  assert.match((await f.pool.query("SELECT body FROM mlg_bot.outbox WHERE body LIKE '%FASE DE LIGA ENCERRADA%' ORDER BY id DESC LIMIT 1")).rows[0].body,/8º/);
  await force(first.code,'0x2','correção oficial da liga');
  knockout=(await f.pool.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 AND round=9 ORDER BY position,leg',[cup.id])).rows;
  assert.equal(knockout.length,4);
  await force(knockout[0].code,'2x0','jogo eliminatório oficial');
  await force(first.code,'2x0','correção tardia indevida');
  assert.match((await f.pool.query('SELECT body FROM mlg_bot.outbox ORDER BY id DESC LIMIT 1')).rows[0].body,/Há placar na fase seguinte/);
  assert.equal((await f.pool.query('SELECT home_score FROM mlg_bot.guest_matches WHERE code=$1',[first.code])).rows[0].home_score,0);
  for(let stage=0;stage<3;stage++){
   const pending=(await f.pool.query("SELECT code FROM mlg_bot.guest_matches WHERE cup_id=$1 AND round=$2 AND status='scheduled' ORDER BY position",[cup.id,9+stage])).rows;
   for(const m of pending)await force(m.code,'2x0','partida eliminatória oficial');
  }
  assert.equal((await f.pool.query('SELECT status FROM mlg_bot.guest_competitions WHERE id=$1',[cup.id])).rows[0].status,'completed');
 }finally{await f.close();}
});

test('liga mista com 25 participantes agenda ida e volta sem códigos duplicados',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);const group='271@g.us';
  await f.pool.query('INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES($1,true,true)',[group]);
  await f.pool.query("INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,'admin','admin')",[group]);
  const db=pgDatabase(f.pool),teams=Array.from({length:25},(_,i)=>'Equipe '+i);
  await guestOpen(db,{group,name:'Brasileirão convidado',mode:'misto',legs:2,size:25,qualifiers:8,teams});
  const identity=async(q:any,aliases:string[])=>{const user=aliases[0];await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$1) ON CONFLICT DO NOTHING',[user]);return user;};
  for(let i=0;i<25;i++)await guestEvent(db,{group,aliases:['u'+i],messageId:'large-'+i,name:'Jogador '+i,text:'!entrar'},identity);
  const games=(await f.pool.query('SELECT count(*)::int AS total,count(DISTINCT code)::int AS unique_codes,max(round)::int AS last_round FROM mlg_bot.guest_matches WHERE cup_id=(SELECT id FROM mlg_bot.guest_competitions WHERE group_id=$1)',[group])).rows[0];
  assert.deepEqual(games,{total:600,unique_codes:600,last_round:49});
 }finally{await f.close();}
});

test('ordenação de chaves e calendário de ida e volta com número ímpar',()=>{
 assert.deepEqual(seededBracket(8),[1,8,4,5,2,7,3,6]);
 assert.equal(guestFixtures('misto',2,Array.from({length:25},(_,i)=>String(i))).length,600);
});

test('auxiliar convidado só administra o próprio grupo e perde acesso ao devolver',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  const call=await guestGateway(f.pool),group='200@g.us',other='201@g.us',manager='5511888888888@s.whatsapp.net',helper='5511777777777@s.whatsapp.net';
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES ($1,true,true),($2,true,true)",[group,other]);
  await f.pool.query("INSERT INTO mlg_bot.users(id,display_name) VALUES ('manager','Manager'); INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES ('5511888888888@s.whatsapp.net','manager');");
  await f.pool.query("INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,'manager','admin')",[group]);
  const grant={action:'guest-admin',group,aliases:[manager],operation:'grant',targetAliases:[helper]};
  assert.equal((await call({...grant,aliases:[helper]})).updated,undefined);
  assert.equal((await call(grant)).updated,true);
  assert.equal((await call({action:'control-check',group,aliases:[helper]})).loanAllowed,true);
  assert.equal((await call({action:'control-check',group:other,aliases:[helper]})).loanAllowed,false);
  assert.equal((await call({action:'control-check',group,aliases:[helper]})).allowed,false);
  assert.equal((await call({action:'guest-admin',group,aliases:[helper],operation:'grant',targetAliases:['5511666666666@s.whatsapp.net']})).updated,undefined);
  assert.equal((await call({action:'guest-admin',group,aliases:[manager],operation:'revoke',targetAliases:[helper]})).updated,true);
  assert.equal((await call({action:'control-check',group,aliases:[helper]})).loanAllowed,false);
  assert.equal((await call(grant)).updated,true);
  await f.pool.query('UPDATE mlg_bot.loan_groups SET active=false WHERE group_id=$1',[group]);
  assert.equal((await call({action:'control-check',group,aliases:[helper]})).loanAllowed,false);
 }finally{await f.close();}
});

for(const mode of ['liga','copa'] as const)for(const legs of [1,2] as const){
 test(`gateway: convite, ativação, ${mode}, ${legs} jogo(s), campeão e isolamento`,integration,async()=>{
  const f=await fixture();try{
   await setup(f.pool);
   await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES ('100@g.us',true,true); INSERT INTO mlg_bot.admins VALUES ('100@g.us','admin','owner'); INSERT INTO mlg_bot.wa_identities VALUES ('5511999999999@s.whatsapp.net','admin');");
   const call=await guestGateway(f.pool),phone='5511888888888@s.whatsapp.net',group='200@g.us';
   const invite={action:'loan-invite',source:'100@g.us',aliases:['5511999999999@s.whatsapp.net'],operation:'grant',targetAliases:[phone]};
   assert.equal((await call({...invite,aliases:['5511777777777@s.whatsapp.net']})).invited,undefined);
   assert.equal((await call(invite)).invited,true);
   assert.equal((await call(invite)).existing,true);
   const privateAccess=await call({action:'loan-private-check',aliases:[phone]});
   assert.equal(privateAccess.allowed,true);assert.equal(privateAccess.claimedGroup,null);assert.ok(Number.isFinite(privateAccess.grantedAt));
   assert.equal((await call({action:'loan-private-check',aliases:['5511000000000@s.whatsapp.net']})).allowed,false);
   assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM mlg_bot.wa_identities WHERE jid='5511000000000@s.whatsapp.net'")).rows[0].n,0);
   assert.equal((await call({action:'loan-claim',group,aliases:['777@lid',phone],name:'Convidado'})).claimed,true);
   assert.equal((await call({action:'loan-private-check',aliases:[phone]})).claimedGroup,group);
   assert.equal((await call(invite)).existing,true);
   const permissions=await call({action:'control-check',group,aliases:[phone]});
   assert.equal(permissions.allowed,false);assert.equal(permissions.loanAllowed,true);
   assert.match((await call({action:'loan-claim',group:'201@g.us',aliases:[phone]})).error,/outro grupo/);
   const claimed=(await f.pool.query('SELECT claimed_group FROM mlg_bot.loan_invitations')).rows[0].claimed_group;
   assert.equal(claimed,group);
   const size=mode==='liga'?3:4;
   assert.equal((await call({action:'guest-open',group,name:'Campeonato convidado',mode,legs,size,teams:['Bahia','Santos','Palmeiras','Flamengo']})).opened,true);
   let serial=0;
   const event=(aliases:string[],text:string)=>call({action:'guest-event',group,aliases,name:'Jogador '+aliases[0],messageId:'guest-e2e-'+ ++serial,text});
   const players=[phone,'5511666666666@s.whatsapp.net','5511555555555@s.whatsapp.net','5511444444444@s.whatsapp.net'].slice(0,size);
   for(const player of players)assert.equal((await event([player],'!entrar')).accepted,true);
   const opening=(await f.pool.query("SELECT body FROM mlg_bot.outbox WHERE group_id=$1 AND body LIKE '🎲 CONFRONTOS · %' ORDER BY id DESC LIMIT 1",[group])).rows[0].body as string;
   assert.match(opening,/!resultado CÓDIGO MxV/);
   assert.match(opening,/!confirmar CÓDIGO MxV/);
   assert.match(opening,/!forcarresultado CÓDIGO MxV motivo/);
   let announced:{mentions:string[]}|undefined;
   for(let page=0;page<3&&!announced;page++){
    const batch=await call({action:'poll'});
    for(const message of batch.messages){
     if(message.body.startsWith('🎲 CONFRONTOS · '))announced=message;
     await call({action:'ack',id:String(message.id),lease:message.lease,sent:true});
    }
   }
   assert.deepEqual(new Set(announced?.mentions),new Set(players));
   const lookup=async(user:string)=>(await f.pool.query('SELECT jid FROM mlg_bot.wa_identities WHERE user_id=$1 AND jid LIKE $2',[user,'%@s.whatsapp.net'])).rows[0].jid as string;
   const manager=(await f.pool.query('SELECT manager_id FROM mlg_bot.loan_groups WHERE group_id=$1',[group])).rows[0].manager_id;
   for(let round=0;round<8;round++){
    const matches=(await f.pool.query("SELECT * FROM mlg_bot.guest_matches WHERE status='scheduled' ORDER BY round,position,leg")).rows;
    if(!matches.length)break;
    for(const match of matches){
     const score=match.away===manager?'0x2':'2x0';
     await event([await lookup(match.home)],`!jogo ${match.code}`);
     assert.match((await f.pool.query('SELECT body FROM mlg_bot.outbox ORDER BY id DESC LIMIT 1')).rows[0].body,new RegExp('#'+match.code));
     await event([await lookup(match.home)],`!resultado ${match.code} ${score}`);
     await event([await lookup(match.away)],`!confirmar ${match.code} ${score}`);
    }
   }
   assert.deepEqual((await f.pool.query('SELECT status,champion_id FROM mlg_bot.guest_competitions')).rows[0],{status:'completed',champion_id:manager});
   assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM mlg_bot.cups')).rows[0].n,0);
   assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM mlg_bot.guest_matches WHERE status<>'confirmed'")).rows[0].n,0);
   assert.equal((await call({action:'loan-invite',source:'100@g.us',aliases:['5511999999999@s.whatsapp.net'],operation:'revoke',targetAliases:[phone]})).revoked,undefined);
  }finally{await f.close();}
 });
}

test('campeonato convidado cancelado não confirma placares automaticamente',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);const group='250@g.us';
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES($1,true,true)",[group]);
  await f.pool.query("INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,'admin','admin')",[group]);
  const db=pgDatabase(f.pool);await guestOpen(db,{group,name:'Liga teste',mode:'liga',legs:1,size:2,teams:['Bahia','Santos']});
  const identity=async(q:any,aliases:string[])=>{const user=aliases[0];await q.query('INSERT INTO mlg_bot.users VALUES($1,$1) ON CONFLICT DO NOTHING',[user]);return user;};
  for(const user of ['a','b'])await guestEvent(db,{group,aliases:[user],messageId:'join-'+user,name:user,text:'!entrar'},identity);
  const match=(await f.pool.query('SELECT code,home FROM mlg_bot.guest_matches')).rows[0];
  await guestEvent(db,{group,aliases:[match.home],messageId:'score',name:match.home,text:`!resultado ${match.code} 2x0`},identity);
  await f.pool.query("UPDATE mlg_bot.guest_matches SET reported_at=$1",[Date.now()-600000]);
  await f.pool.query("UPDATE mlg_bot.guest_competitions SET status='cancelled'");
  assert.equal((await guestAutoConfirm(db)).confirmed,false);
  assert.equal((await f.pool.query('SELECT status FROM mlg_bot.guest_matches')).rows[0].status,'pending');
 }finally{await f.close();}
});

test('grupo emprestado disputa liga de ida e volta, confirma e arquiva só o campeão',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);
  const group='123@g.us';
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES($1,true,true)",[group]);
  await f.pool.query("INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,'admin','admin')",[group]);
  const db=pgDatabase(f.pool),teams=['Bahia','Santos','Palmeiras'];
  assert.equal((await guestOpen(db,{group,name:'Liga do Amério',mode:'liga',legs:2,size:3,teams})).opened,true);
  let serial=0;
  const identity=async(q:any,aliases:string[],name:string)=>{
   const id=aliases[0]!.split('@')[0];await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,name]);return id;
  };
  const send=(user:string,text:string,id='guest-'+ ++serial)=>guestEvent(db,{group,aliases:[user+'@s.whatsapp.net'],messageId:id,name:user,text},identity);
  for(const user of ['u0','u1','u2'])await send(user,'!entrar');
  const matches=(await f.pool.query<{code:number;home:string;away:string;status:string}>('SELECT code,home,away,status FROM mlg_bot.guest_matches ORDER BY round,position')).rows;
  assert.equal(matches.length,6);assert.equal(new Set(matches.map(m=>m.code)).size,6);
  for(const m of matches){
   const result=m.home==='u0'?'2x0':m.away==='u0'?'0x2':'1x1';
   await send(m.home,`!resultado ${m.code} ${result}`);
   await send(m.away,`!confirmar ${m.code} ${result}`);
  }
  assert.deepEqual((await f.pool.query('SELECT status,champion_id FROM mlg_bot.guest_competitions')).rows[0],{status:'completed',champion_id:'u0'});
  assert.equal((await f.pool.query('SELECT count(*)::int AS total FROM mlg_bot.guest_result_audit')).rows[0].total,12);
  await f.pool.query("UPDATE mlg_bot.guest_competitions SET completed_at=$1",[Date.now()-700000]);
  await f.pool.query("UPDATE mlg_bot.outbox SET status='sent'");
  assert.equal((await guestArchive(db)).archived,true);
  assert.equal((await f.pool.query('SELECT champion_name FROM mlg_bot.loan_champions')).rows[0].champion_name,'u0');
  assert.equal((await f.pool.query('SELECT count(*)::int AS total FROM mlg_bot.guest_matches')).rows[0].total,0);
 }finally{await f.close();}
});

test('mata-mata emprestado soma dois jogos e abre desempate agregado',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);const group='124@g.us';
  await f.pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES($1,true,true)",[group]);
  await f.pool.query("INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,'admin','admin')",[group]);
  const db=pgDatabase(f.pool),identity=async(q:any,aliases:string[],name:string)=>{const id=aliases[0]!.split('@')[0];await q.query('INSERT INTO mlg_bot.users VALUES($1,$2) ON CONFLICT DO NOTHING',[id,name]);return id;};
  let n=0;const send=(user:string,text:string,id='cup-'+ ++n)=>guestEvent(db,{group,aliases:[user+'@s.whatsapp.net'],messageId:id,name:user,text},identity);
  await guestOpen(db,{group,name:'Copa do Amério',mode:'copa',legs:2,size:4,teams:['Bahia','Santos','Palmeiras','Flamengo']});
  for(const user of ['u0','u1','u2','u3'])await send(user,'!entrar');
  const first=(await f.pool.query<{code:number;home:string;away:string;leg:number}>('SELECT code,home,away,leg FROM mlg_bot.guest_matches ORDER BY round,position,leg')).rows;
  assert.equal(first.length,4);
  for(const m of first){const result=m.leg===1?'2x0':'0x1';await send(m.home,`!resultado ${m.code} ${result}`);await send(m.away,`!confirmar ${m.code} ${result}`);}
  const final=(await f.pool.query<{code:number;home:string;away:string;leg:number}>('SELECT code,home,away,leg FROM mlg_bot.guest_matches WHERE round=1 ORDER BY leg')).rows;
  assert.equal(final.length,2);
  for(const m of final){await send(m.home,`!resultado ${m.code} 1x1`);await send(m.away,`!confirmar ${m.code} 1x1`);}
  const decider=(await f.pool.query<{code:number;home:string;away:string;leg:number}>('SELECT code,home,away,leg FROM mlg_bot.guest_matches WHERE round=1 AND leg=3')).rows[0]!;
  assert.equal(decider.leg,3);await send(decider.home,`!resultado ${decider.code} 5x4`);await send(decider.away,`!confirmar ${decider.code} 5x4`);
  assert.deepEqual((await f.pool.query('SELECT status,champion_id FROM mlg_bot.guest_competitions')).rows[0],{status:'completed',champion_id:decider.home});
 }finally{await f.close();}
});

test('configuração nomeada persiste entre comandos e novo grupo não mistura campeões',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);await f.pool.query("UPDATE mlg_bot.groups SET competition_name='Copa Oficial' WHERE id='g'");let id=0;
  const send=(userId:string,text:string)=>processEvent(pgDatabase(f.pool),{id:'setup-'+ ++id,groupId:'g',userId,name:userId,text,at:Date.now()+id});
  await send('admin','!novacopa');await send('admin','!nome Copa Nova');
  await f.restartClient();await send('admin','!categoria clube');await send('admin','!formato 8');
  await send('admin','!jogos 1');await send('admin','!abrircopa');
  const current=(await f.pool.query<{competition_name:string;size:number;legs:number;status:string}>('SELECT competition_name,size,legs,status FROM mlg_bot.cups')).rows[0]!;
  assert.deepEqual(current,{competition_name:'Copa Nova',size:8,legs:1,status:'open'});
  assert.equal((await f.pool.query('SELECT * FROM mlg_bot.command_drafts')).rows.length,0);
  assert.match((await send('u0','!entrar')).notices.join(''),/INSCRIÇÃO CONFIRMADA/);
 }finally{await f.close();}
});

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
test('PostgreSQL: prazo automático persiste após reconexão, não duplica e respeita contestação',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);const db=pgDatabase(f.pool);let seq=0;
  const send=(who:string,text:string)=>processEvent(db,{id:'autodb-'+ ++seq,groupId:'g',userId:who,name:who,text,at:Date.now()});
  await send('admin','!novacopa');await send('admin','!formato 4');for(let i=0;i<4;i++)await send('u'+i,'!entrar');
  const games=(await f.pool.query<{code:string;home:string;away:string}>('SELECT code,home,away FROM mlg_bot.matches ORDER BY position')).rows;
  await send(games[0]!.home,`!resultado ${games[0]!.code} 3x1`);
  await send(games[1]!.home,`!resultado ${games[1]!.code} 2x1`);
  await send(games[1]!.away,`!contestar ${games[1]!.code}`);
  await f.restartClient();
  assert.equal(await autoConfirmDue(pgDatabase(f.pool),Date.now()+300001),1);
  assert.equal(await autoConfirmDue(pgDatabase(f.pool),Date.now()+300001),0);
  const rows=(await f.pool.query<{code:string;status:string;revisions:number}>(`SELECT m.code::text AS code,m.status,count(r.revision)::int AS revisions FROM mlg_bot.matches m JOIN mlg_bot.match_results r ON r.match_code=m.code GROUP BY m.code,m.status ORDER BY m.code`)).rows;
  assert.equal(rows.find(row=>row.code===games[0]!.code)?.status,'confirmed');
  assert.equal(rows.find(row=>row.code===games[0]!.code)?.revisions,1);
  assert.equal(rows.find(row=>row.code===games[1]!.code)?.status,'disputed');
  assert.equal((await f.pool.query("SELECT count(*)::int AS total FROM mlg_bot.outbox WHERE body LIKE '%RESULTADO CONFIRMADO%' AND user_id='mlg-auto-confirm'")).rows[0].total,1);
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

test('membro bloqueado não cria inscrição nem resultado e mensagens repetidas continuam idempotentes',integration,async()=>{
 const f=await fixture();try{
  await setup(f.pool);const db=pgDatabase(f.pool);
  await f.pool.query("INSERT INTO mlg_bot.users(id,display_name) VALUES('u0','Jogador de teste')");
  await f.pool.query("INSERT INTO mlg_bot.member_blocks(user_id,blocked_by,reason) VALUES('u0','admin','Quebra das regras do grupo')");
  const event={id:'blocked-1',groupId:'g',userId:'u0',name:'u0',text:'!entrar',at:Date.now()};
  await processEvent(db,{...event,id:'open',userId:'admin',text:'!novacopa'});
  await processEvent(db,{...event,id:'format',userId:'admin',text:'!formato 4'});
  const first=await processEvent(db,event);assert.deepEqual(first.notices,[]);
  assert.equal((await processEvent(db,event)).duplicate,true);
  assert.equal((await f.pool.query("SELECT count(*)::int AS total FROM mlg_bot.cup_participants WHERE user_id='u0'")).rows[0].total,0);
  await f.pool.query("DELETE FROM mlg_bot.member_blocks WHERE user_id='u0'");
  const restored=await processEvent(db,{...event,id:'unblocked-1'});
  assert.match(restored.notices.join(' '),/INSCRIÇÃO CONFIRMADA/);
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
  const third=await cupRerollTeam(db,{...base,targetName:'Samuel',messageId:'change-3'});
  assert.ok(third.newTeam&&!['Ucrânia','Rússia',first.newTeam,second.newTeam].includes(third.newTeam));
  assert.deepEqual((await f.pool.query('SELECT code,round,position,home,away,winner,status FROM mlg_bot.matches WHERE cup_id=$1 ORDER BY code',[cup])).rows,before);
  assert.equal((await f.pool.query('SELECT count(*)::int AS total FROM mlg_bot.match_results WHERE match_code=$1',[match.code])).rows[0].total,1);
  const active=(await f.pool.query('SELECT user_id,club FROM mlg_bot.cup_participants WHERE cup_id=$1',[cup])).rows;
  assert.equal(active.find(p=>p.user_id==='u0')?.club,third.newTeam);assert.equal(active.find(p=>p.user_id==='u1')?.club,second.newTeam);
  assert.equal((await f.pool.query("SELECT count(*)::int AS total FROM mlg_bot.audit_logs WHERE cup_id=$1 AND action='team-reroll'",[cup])).rows[0].total,3);
  assert.equal((await f.pool.query("SELECT count(*)::int AS total FROM mlg_bot.cup_checkpoints WHERE cup_id=$1 AND event_id LIKE 'team-reroll-%'",[cup])).rows[0].total,6);
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
  await send('admin','!nome Copa do Mundo');await send('admin','!categoria seleção');await send('admin','!formato 4');await send('admin','!jogos 1');await send('admin','!abrircopa');for(let i=0;i<4;i++)await send('j'+i,'!entrar');
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
  const factory=new Function('Pool','randomUUID','pgDatabase','processEvent','autoConfirmDue','guestAutoConfirm','guestArchive','checkpointCup','cupRerollTeam','minicampClubs','memberCommand','Deno','crypto',source);
  const client=f.pool;
  factory(class {constructor(){return client;}},randomUUID,pgDatabase,processEvent,autoConfirmDue,guestAutoConfirm,guestArchive,checkpointCup,cupRerollTeam,[],memberCommand,{env:{get:()=>''},serve:(fn:typeof handler)=>{handler=fn;}},webcrypto);
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
  const access={source:'100@g.us',group:'100@g.us',aliases:['100@s.whatsapp.net']};
  assert.equal((await call('admin-access',{...access,operation:'grant',targetAliases:['300@s.whatsapp.net'],role:'channel'})).updated,true);
  const scoped=await call('control-check',{aliases:['300@s.whatsapp.net']});
  assert.equal(scoped.allowed,false);assert.equal(scoped.channelAllowed,true);
  assert.match(String((await call('member-block',{group:'100@g.us',aliases:['300@s.whatsapp.net'],operation:'list'})).error),/Somente ADMs/);
  assert.equal((await f.pool.query("SELECT role FROM mlg_bot.admins WHERE group_id='100@g.us' AND user_id=(SELECT user_id FROM mlg_bot.wa_identities WHERE jid='300@s.whatsapp.net')")).rows[0].role,'channel');
  assert.equal((await call('admin-access',{...access,operation:'revoke',targetAliases:['300@s.whatsapp.net']})).updated,true);
  assert.equal((await call('control-check',{aliases:['300@s.whatsapp.net']})).channelAllowed,false);
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
  const liveCup=(await f.pool.query("SELECT id FROM mlg_bot.cups WHERE group_id='100@g.us' AND status='open' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  await f.pool.query("INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position) VALUES($1,'winner','Vencedor',0)",[liveCup]);
  await f.pool.query("INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES('400@s.whatsapp.net','winner') ON CONFLICT DO NOTHING");
  assert.equal((await call('member-block',{group:'100@g.us',aliases:['100@s.whatsapp.net'],operation:'block',targetAliases:['400@s.whatsapp.net'],reason:'Intervenção administrativa de teste'})).updated,true);
  assert.equal((await call('block-check',{aliases:['400@s.whatsapp.net']})).blocked,true);
  assert.equal((await call('member-block',{group:'100@g.us',aliases:['100@s.whatsapp.net'],operation:'unblock',targetAliases:['400@s.whatsapp.net'],reason:'Reintegração após correção de teste'})).updated,true);
  const updated=await f.pool.query<{competition_name:string;team_kind:string;teams:string}>("SELECT g.competition_name,g.team_kind,(SELECT string_agg(name,', ' ORDER BY name) FROM mlg_bot.club_pool WHERE group_id=g.id) AS teams FROM mlg_bot.groups g WHERE g.id='100@g.us'");
  assert.equal(updated.rows[0]!.competition_name,'Copa Administração MLG');
  assert.equal(updated.rows[0]!.team_kind,'seleção');
  assert.equal(updated.rows[0]!.teams,'Argentina, Brasil, França, Portugal');
  assert.match(String((await call('cup-open',{size:4,proposal:{name:'Outra Copa MLG',teamKind:'clube',teams:['Time A','Time B','Time C','Time D']}})).error),/Já existe/);
  assert.equal((await f.pool.query("SELECT competition_name FROM mlg_bot.groups WHERE id='100@g.us'")).rows[0].competition_name,'Copa Administração MLG');
  const seasonActor={source:'100@g.us',aliases:['100@s.whatsapp.net'],messageId:'season-confirm-1'};
  const activePreview=await call('season-preview',seasonActor);
  assert.equal(activePreview.active,1);
  assert.match(String((await call('season-reset',{...seasonActor,fingerprint:activePreview.fingerprint})).error),/em andamento/);
  await call('cup-cancel',{reason:'Encerramento da temporada de teste'});
  const preview=await call('season-preview',seasonActor);
  assert.equal(preview.active,0);
  assert.ok(Number(preview.cups)>0);
  assert.match(String((await call('season-reset',{...seasonActor,fingerprint:'stale'})).error),/mudaram/);
  const reset=await call('season-reset',{...seasonActor,fingerprint:preview.fingerprint});
  assert.equal(reset.season,2);
  for(const table of ['cups','cup_participants','matches','match_results','cup_checkpoints','command_drafts','audit_logs','inbox','outbox','processed_messages','command_rate']){
   assert.equal(Number((await f.pool.query(`SELECT count(*) AS n FROM mlg_bot.${table}`)).rows[0].n),0,table);
  }
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.coach_profiles WHERE group_id='100@g.us'")).rows[0].display_name,'Técnico');
  assert.equal((await f.pool.query("SELECT user_id FROM mlg_bot.wa_identities WHERE jid='100@s.whatsapp.net'")).rows[0].user_id,'admin');
  assert.equal((await f.pool.query("SELECT display_name FROM mlg_bot.users WHERE id='winner'")).rows[0].display_name,'Vencedor');
  assert.equal((await call('season-preview',seasonActor)).season,2);
  assert.match(String((await call('season-reset',{...seasonActor,fingerprint:preview.fingerprint})).error),/mudaram/);
  const resetAt=Number((await f.pool.query("SELECT extract(epoch FROM at)*1000 AS at FROM mlg_bot.control_audit WHERE action='season-reset'")).rows[0].at);
  const obsolete=await processEvent(pgDatabase(f.pool),{id:'obsolete-season',groupId:'100@g.us',userId:'admin',name:'Admin',text:'!novacopa',at:resetAt-1000});
  assert.equal(obsolete.duplicate,true);
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM mlg_bot.cups')).rows[0].n,'0');
  assert.equal((await call('cup-open',{size:4})).edition,1);
  const openCup=(await f.pool.query("SELECT id FROM mlg_bot.cups WHERE group_id='100@g.us' AND status='open'")).rows[0].id;
  for(let i=1;i<=4;i++){
   await f.pool.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2)', ['semi-'+i,'Semifinalista '+i]);
   await f.pool.query('INSERT INTO mlg_bot.cup_participants(cup_id,user_id,display_name,position) VALUES($1,$2,$3,$4)',[openCup,'semi-'+i,'Semifinalista '+i,i-1]);
   await f.pool.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2)',[String(700+i)+'@s.whatsapp.net','semi-'+i]);
  }
  await f.pool.query("INSERT INTO mlg_bot.matches(code,cup_id,round,position,home,away,status) VALUES (901,$1,0,0,'semi-1','semi-2','scheduled'),(902,$1,0,1,'semi-3','semi-4','scheduled')",[openCup]);
  await f.pool.query("INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES ('100@g.us','admin','semis-test',$1)",[Date.now()]);
  await f.pool.query("INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES ('100@g.us','admin','semis-test',0,$1)",['⚔️ SEMIFINAL · 2 jogos\n📣 SEMIFINALISTAS · jogos #901 e #902']);
  const announcements=await call('poll');
  const semis=(announcements.messages as {body:string;mentions:string[]}[]).find(m=>m.body.includes('SEMIFINALISTAS'));
  assert.deepEqual(semis?.mentions.sort(),['701@s.whatsapp.net','702@s.whatsapp.net','703@s.whatsapp.net','704@s.whatsapp.net']);
 }finally{await f.close();}
});
