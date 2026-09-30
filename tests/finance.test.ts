import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {money,moneyText,MAX_MONEY} from '../src/finance/money.ts';
import {financeCommand,financialText} from '../src/finance/commands.ts';
import {financeDisabled} from '../src/finance/client.ts';
import {financeEvent,financePoll,financeAck,type FinanceDatabase} from '../src/finance/store.ts';
import {pgDatabase} from '../src/infra/postgres.ts';

test('dinheiro virtual usa unidades inteiras e rejeita ambiguidade, sinais e expoentes',()=>{
 for(const [text,units] of [['1',100],['0,01',1],['1.000,50',100050],['1000,5',100050],['10.000.000.000',MAX_MONEY]] as const)assert.equal(money(text),units);
 for(const value of ['0','-1','+1','1e4','1.00','1,000','1,5,0','R$ 10','NaN','Infinity','10.000.000.001','', '1 000'])assert.throws(()=>money(value));
 assert.equal(moneyText(100050),'1.000,50 MLG');assert.equal(moneyText(-1),'-0,01 MLG');
 assert.equal(moneyText(9007199254740993n),'90.071.992.547.409,93 MLG');
});
test('comandos financeiros não capturam empréstimo do bot ou confirmação da Copa',()=>{
 assert.equal(financialText('!emprestar 5511888888888'),false);
 assert.equal(financeCommand('!confirmar 432'),null);assert.equal(financeCommand('!sim'),null);
 assert.deepEqual(financeCommand('!sim F1234567890'),{type:'accept',code:'F1234567890'});
 assert.deepEqual(financeCommand('!banco pedir 1.000,50 15'),{type:'request',amount:100050,days:15});
 assert.equal(financeCommand('!sim F1234567890 outro'),null);
 assert.deepEqual(financeCommand('!financeiro relatorio temporada T2027 2'),{type:'report',page:2,season:'T2027'});
 assert.match(financeDisabled,/Nenhuma proposta, dívida ou transferência/);
});

const integration={skip:!process.env.MLG_TEST_DATABASE_URL};
const NOW=Date.UTC(2027,0,1,12);
const group='100@g.us';
const identities={adm:'100@s.whatsapp.net',adm2:'101@s.whatsapp.net',alice:'200@s.whatsapp.net',bob:'300@s.whatsapp.net',other:'400@s.whatsapp.net'};
type User=keyof typeof identities;
async function fixture(){
 const initialUrl=process.env.MLG_TEST_DATABASE_URL!;
 const root=new Pool({connectionString:initialUrl}),name='finance_test_'+randomUUID().replaceAll('-','');
 await root.query('CREATE DATABASE '+name);
 const url=new URL(initialUrl);url.pathname='/'+name;
 const pool=new Pool({connectionString:url.toString()});
 try{
  await pool.query("DO $$ BEGIN PERFORM pg_advisory_xact_lock(71012999); IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; END IF; END $$");
  for(const file of ['001_initial.sql','002_worker.sql','003_minicamp_gateway.sql','004_controls_history.sql','015_member_blocks.sql','019_admin_scopes.sql','020_loan_groups.sql'])await pool.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../supabase/migrations/20260930150109_finance_loans.sql',import.meta.url),'utf8'));
  for(const [user,jid] of Object.entries(identities)){
   await pool.query('INSERT INTO mlg_bot.users VALUES($1,$1)',[user]);await pool.query('INSERT INTO mlg_bot.wa_identities VALUES($1,$2)',[jid,user]);
  }
  await pool.query("INSERT INTO mlg_bot.groups(id,authorized,admins_configured) VALUES($1,true,true),('200@g.us',true,true)",[group]);
  await pool.query("INSERT INTO mlg_bot.admins VALUES($1,'adm','owner'),($1,'adm2','admin')",[group]);
 }catch(error){await pool.end();await root.query('DROP DATABASE '+name);await root.end();throw error;}
 const db:FinanceDatabase={transaction:run=>pgDatabase(pool).transaction(async q=>{await q.query('SET LOCAL ROLE mlg_finance_gateway');return run(q);})};
 let serial=0,lastCode:string;
 const send=async(user:User,text:string,target?:User,id='finance-'+ ++serial,at=NOW)=>{const response=await financeEvent(db,{group,aliases:[identities[user]],targetAliases:target?[identities[target]]:undefined,id,name:user,text},at);const match=response.body?.match(/^💰 PROPOSTA (F[A-Z0-9]{10})/);if(match)lastCode=match[1]!;return response;};
 const setup=async(mode='both',approval='manual')=>{
  await send('adm','!financeiro preparar T2027');
  await send('adm',`!financeiro regras 5000 10000 60 5 ${approval}`);
  await send('adm','!financeiro creditar banco 5000 Reserva inicial da temporada');
  await send('adm','!financeiro creditar @Alice 1000 Saldo inicial da temporada','alice');
  await send('adm','!financeiro administracao '+group);
  await send('adm',`!financeiro ativar ${mode} T2027`);
 };
 const balance=async(owner:string)=>{
  const r=await pool.query(`SELECT coalesce(sum(CASE WHEN j.destination=w.id THEN j.amount ELSE -j.amount END),0)::text AS amount
   FROM mlg_finance.wallets w LEFT JOIN mlg_finance.journal j ON j.source=w.id OR j.destination=w.id
   WHERE w.owner_id=$1 GROUP BY w.id`,[owner]);return Number(r.rows[0]?.amount??0);
 };
 const code=async()=>lastCode;
 return {pool,db,send,setup,balance,code,close:async()=>{await pool.end();await root.query('DROP DATABASE '+name);await root.end();}};
}

test('pessoas: menção, consentimento correto, extrato, pagamentos parciais e auditoria',integration,async()=>{
 const f=await fixture();try{
  await f.setup('pessoas');
  const proposal=await f.send('alice','!emprestardinheiro @Bob 250,50 15','bob','offer-1');
  assert.match(proposal.body!,/Nenhum saldo foi transferido/);
  const code=await f.code();assert.match(code,/^F[A-Z0-9]{10}$/);
  assert.equal(await f.balance('alice'),100000);assert.equal(await f.balance('bob'),0);
  const outbox=(await f.pool.query('SELECT mentions FROM mlg_finance.outbox WHERE message_id=$1',['offer-1'])).rows[0];assert.deepEqual(outbox.mentions,[identities.bob]);
  assert.match((await f.send('other','!sim '+code)).body!,/Só a conta/);
  assert.match((await f.send('alice','!sim '+code)).body!,/Só a conta/);
  assert.match((await f.send('bob','!sim '+code,undefined,'accept-1')).body!,/CONFIRMADO/);
  assert.equal((await f.send('bob','!sim '+code,undefined,'accept-1')).duplicate,true);
  assert.match((await f.send('bob','!sim '+code)).body!,/não está disponível/);
  assert.equal(await f.balance('alice'),74950);assert.equal(await f.balance('bob'),25050);
  assert.match((await f.send('other','!financeiro pagar '+code+' 10')).body!,/Só o devedor/);
  assert.match((await f.send('bob','!financeiro pagar '+code+' 251')).body!,/excede/);
  assert.match((await f.send('bob','!financeiro pagar '+code+' 100')).body!,/Restante: 150,50/);
  assert.match((await f.send('bob','!financeiro pagar '+code+' 150,50')).body!,/quitado/);
  assert.equal(await f.balance('alice'),100000);assert.equal(await f.balance('bob'),0);
  assert.match((await f.send('bob','!financeiro extrato')).body!,/250,50 MLG/);
  const ledger=(await f.pool.query("SELECT kind,count(*)::int n FROM mlg_finance.journal WHERE loan_id=$1 GROUP BY kind",[code])).rows;
  assert.equal(ledger.find(r=>r.kind==='disbursement').n,1);assert.equal(ledger.find(r=>r.kind==='repayment').n,2);
  assert.match((await f.send('other','!financeiro relatorio')).body!,/Somente ADMs/);
  assert.match((await f.send('adm','!financeiro relatorio')).body!,/saldo a devolver: 0,00/);
  assert.match((await f.send('adm','!financeiro encerrar T2027')).body!,/preservados/);
  assert.match((await f.send('adm','!financeiro relatorio temporada T2027')).body!,new RegExp(code));
  assert.match((await f.send('adm','!financeiro preparar T2028')).body!,/DESLIGADO/);
  assert.match((await f.send('bob','!financeiro saldo')).body!,/0,00/);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM mlg_finance.loans')).rows[0].n,1);
 }finally{await f.close();}
});

test('banco manual exige ADM distinto e confirmação do solicitante; pausado aceita pagamento',integration,async()=>{
 const f=await fixture();try{
  await f.setup('banco');
  await f.send('adm','!banco pedir 500 30');const code=await f.code();
  assert.match((await f.send('adm','!financeiro aprovar '+code)).body!,/Outro ADM/);
  assert.match((await f.send('bob','!financeiro aprovar '+code)).body!,/Somente ADMs/);
  assert.match((await f.send('adm','!sim '+code)).body!,/aguardando ADM/);
  assert.match((await f.send('adm2','!financeiro aprovar '+code)).body!,/aprovou/);
  assert.equal(await f.balance('adm'),0);
  assert.match((await f.send('adm','!sim '+code)).body!,/CONFIRMADO/);
  assert.equal(await f.balance('adm'),50000);
  assert.match((await f.send('adm','!financeiro pausar T2027')).body!,/Pauser|Pausar|pausar/);
  assert.match((await f.send('bob','!banco pedir 10 2')).body!,/desativado/);
  assert.match((await f.send('adm','!financeiro encerrar T2027')).body!,/Há propostas ou dívidas/);
  assert.match((await f.send('adm','!financeiro ativar pessoas T2027')).body!,/Não alterei/);
  assert.match((await f.send('adm','!financeiro pagar '+code+' 500')).body!,/quitado/);
 }finally{await f.close();}
});

test('banco automático recusa limites e vencimento sem inferir crédito por nome ou equipe',integration,async()=>{
 const f=await fixture();try{
  await f.setup('banco','automatico');
  assert.match((await f.send('bob','!banco pedir 5001 1')).body!,/limite por empréstimo/);
  assert.match((await f.send('bob','!banco pedir 100 61')).body!,/Prazo/);
  await f.send('bob','!banco pedir 100 1');const code=await f.code();
  assert.equal((await f.pool.query('SELECT status FROM mlg_finance.loans WHERE id=$1',[code])).rows[0].status,'pending_acceptance');
  await f.send('bob','!sim '+code);
  assert.match((await f.send('bob','!banco pedir 10 2',undefined,'late-request',NOW+2*86400000)).body!,/Novo empréstimo indisponível/);
  assert.match((await f.send('bob','!financeiro pagar '+code+' 100',undefined,'late-pay',NOW+2*86400000)).body!,/quitado/);
 }finally{await f.close();}
});

test('confirmações concorrentes e propostas concorrentes nunca duplicam transferência ou deixam saldo negativo',integration,async()=>{
 const f=await fixture();try{
  await f.setup('pessoas');
  await f.send('alice','!emprestardinheiro @Bob 700 5','bob');const first=await f.code();
  await f.send('alice','!emprestardinheiro @Other 700 5','other');
  const second=(await f.pool.query('SELECT id FROM mlg_finance.loans WHERE id<>$1',[first])).rows[0].id;
  await Promise.all([f.send('bob','!sim '+first,undefined,'concurrent-a'),f.send('other','!sim '+second,undefined,'concurrent-b')]);
  assert.equal(await f.balance('alice'),30000);
  assert.equal(await f.balance('bob')+await f.balance('other'),70000);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM mlg_finance.journal WHERE kind='disbursement'")).rows[0].n,1);
  const active=(await f.pool.query("SELECT id FROM mlg_finance.loans WHERE status='active'")).rows[0].id;
  const owner=await f.balance('bob')?'bob':'other';
  await Promise.all([f.send(owner,'!financeiro pagar '+active+' 500',undefined,'pay-a'),f.send(owner,'!financeiro pagar '+active+' 500',undefined,'pay-b')]);
  assert.equal((await f.pool.query('SELECT paid::text FROM mlg_finance.loans WHERE id=$1',[active])).rows[0].paid,'50000');
 }finally{await f.close();}
});

test('expiração, recusa e bloqueio preservam saldo; pagamento continua disponível ao bloqueado',integration,async()=>{
 const f=await fixture();try{
  await f.setup('pessoas');await f.send('alice','!emprestardinheiro @Bob 100 5','bob');const expired=await f.code();
  assert.match((await f.send('bob','!sim '+expired,undefined,'expired',NOW+86400000)).body!,/vencida/);
  assert.equal(await f.balance('alice'),100000);
  await f.send('bob','!financeiro status',undefined,'cleanup',NOW+86400000);
  assert.equal((await f.pool.query('SELECT status FROM mlg_finance.loans WHERE id=$1',[expired])).rows[0].status,'expired');
  await f.send('alice','!emprestardinheiro @Bob 100 5','bob');const rejected=await f.code();
  await f.send('bob','!nao '+rejected);
  assert.match((await f.send('bob','!sim '+rejected)).body!,/não está disponível/);
  await f.send('alice','!emprestardinheiro @Bob 100 5','bob');const active=await f.code();await f.send('bob','!sim '+active);
  await f.send('adm','!financeiro bloquear @Bob Revisão de crédito da equipe','bob');
  assert.match((await f.send('alice','!emprestardinheiro @Bob 10 5','bob')).body!,/Conta impedida/);
  assert.match((await f.send('bob','!financeiro pagar '+active+' 100')).body!,/quitado/);
 }finally{await f.close();}
});

test('papel de backend protege o livro contábil e identidade financeira permanece isolada por grupo',integration,async()=>{
 const f=await fixture();try{
  assert.match((await f.send('bob','!financeiro preparar T2027')).body!,/Somente ADMs/);
  await f.setup('pessoas');
  assert.match((await f.send('alice','!emprestardinheiro @Alice 10 5','alice')).body!,/própria conta/);
  assert.match((await f.send('alice','!emprestardinheiro @Bob 2000 5','bob')).body!,/insuficiente/);
  await f.send('alice','!emprestardinheiro @Bob 100 5','bob');const code=await f.code();
  const wrongGroup=await financeEvent(f.db,{group:'200@g.us',aliases:[identities.bob],id:'wrong-group',name:'bob',text:'!sim '+code},NOW);
  assert.doesNotMatch(wrongGroup.body!,/CONFIRMADO/);assert.equal(await f.balance('bob'),0);
  await assert.rejects(f.db.transaction(q=>q.query('DELETE FROM mlg_finance.journal')),/permission denied/);
  await assert.rejects(f.db.transaction(q=>q.query('UPDATE mlg_finance.events SET action=$1',['forged'])),/permission denied/);
  const inaccessible=await f.pool.query("SELECT has_schema_privilege('anon','mlg_finance','USAGE') AS anon,has_table_privilege('authenticated','mlg_finance.loans','SELECT') AS member");assert.deepEqual(inaccessible.rows[0],{anon:false,member:false});
  const liveRoles=await f.pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='mlg_finance_gateway'");assert.equal(liveRoles.rows[0].rolcanlogin,false);
 }finally{await f.close();}
});

test('outbox financeira tem lease, ID estável, confirmação restrita ao lease e falha após tentativas',integration,async()=>{
 const f=await fixture();try{
  await f.send('bob','!financeiro ajuda');
  const first=(await financePoll(f.db,NOW)).messages[0]!;
  assert.equal((await financePoll(f.db,NOW)).messages.length,0);
  assert.equal((await financeAck(f.db,first.id,randomUUID(),true,NOW)).acknowledged,false);
  const retry=(await financePoll(f.db,NOW+90001)).messages[0]!;assert.equal(retry.id,first.id);assert.notEqual(retry.lease,first.lease);
  await financeAck(f.db,retry.id,retry.lease,false,NOW+90001);
  await f.pool.query("UPDATE mlg_finance.outbox SET attempts=10,status='sending',lease_until=$1",[NOW]);
  assert.equal((await financePoll(f.db,NOW+100000)).messages.length,0);
  assert.equal((await f.pool.query('SELECT status FROM mlg_finance.outbox')).rows[0].status,'failed');
 }finally{await f.close();}
});

test('banco abastecido, limite individual e segunda solicitação recusada preservam a reserva',integration,async()=>{
 const f=await fixture();try{
  await f.setup('banco','automatico');
  assert.match((await f.send('bob','!adicionarsaldo 1000000000')).body!,/Somente ADMs/);
  assert.match((await f.send('adm','!adicionarsaldo 1000000000')).body!,/alocados ao banco/);
  await f.send('adm','!financeiro limite @Bob 100 100 1','bob');
  assert.match((await f.send('bob','!banco pedir 101 1',undefined,'limit-notice')).body!,/limite por empréstimo/);
  assert.equal((await f.pool.query('SELECT recipient FROM mlg_finance.outbox WHERE message_id=$1 AND recipient IS NOT NULL',["limit-notice"])).rows[0].recipient,identities.bob);
  await f.send('bob','!banco pedir 100 1');const code=await f.code();await f.send('bob','!sim '+code);
  assert.match((await f.send('bob','!banco pedir 1 1')).body!,/Limite de empréstimos/);
  assert.match((await f.send('adm','!financeiro ranking')).body!,/bob: 100,00/);
  await f.send('bob','!financeiro transferir @Alice 50 Pagamento virtual combinado','alice');
  assert.equal(await f.balance('bob'),5000);
  assert.match((await f.send('bob','!financeiro transferir @Alice 51 Pagamento virtual combinado','alice')).body!,/Saldo insuficiente/);
  assert.equal(await f.balance('bob'),5000);
  const bank=(await f.pool.query("SELECT w.id FROM mlg_finance.wallets w WHERE kind='bank'")).rows[0].id;
  const treasury=(await f.pool.query('SELECT coalesce(sum(CASE WHEN destination=$1 THEN amount ELSE -amount END),0)::text balance FROM mlg_finance.journal WHERE source=$1 OR destination=$1',[bank])).rows[0].balance;
  assert.equal(treasury,'100000490000');
 }finally{await f.close();}
});

test('vencimento gera apenas avisos privados/administração por dia; emissão gera sinal econômico geral',integration,async()=>{
 const f=await fixture();try{
  await f.setup('banco','automatico');
  await f.send('adm','!financeiro alertas 100 80');
  await f.send('bob','!banco pedir 100 1');const code=await f.code();await f.send('bob','!sim '+code);
  const late=NOW+2*86400000;
  await financePoll(f.db,late);
  const notices=(await f.pool.query("SELECT recipient,body FROM mlg_finance.outbox WHERE message_id LIKE '%overdue%' ORDER BY recipient")).rows;
  assert.equal(notices.length,2);assert.deepEqual(notices.map(n=>n.recipient),[group,identities.bob]);
  assert.ok(notices.every(n=>n.body.includes(code)));assert.ok(notices.every(n=>n.recipient!==null));
  await financePoll(f.db,late+3600001);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM mlg_finance.outbox WHERE message_id LIKE '%overdue%'")).rows[0].n,2);
  await f.send('adm','!adicionarsaldo 200',undefined,'mint-late',late+7200000);
  await financePoll(f.db,late+7200001);
  const alerts=(await f.pool.query("SELECT recipient,body FROM mlg_finance.outbox WHERE message_id LIKE '%economic%'")).rows;
  assert.equal(alerts.length,3);assert.ok(alerts.some(a=>a.recipient===null));assert.ok(alerts.every(a=>a.body.includes('não comprova inflação')));
  await financePoll(f.db,late+86400000);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM mlg_finance.outbox WHERE message_id LIKE '%overdue%'")).rows[0].n,4);
 }finally{await f.close();}
});

test('base de 25 clubes conserva saldo negativo, transfer ban e total; referência aceita milhões sem afetar dinheiro',async()=>{
 const {initialClubs,referenceMoney}=await import('../src/finance/reference.ts');
 assert.equal(initialClubs.length,25);assert.equal(initialClubs.reduce((n,c)=>n+c.balance,0),97700000000);
 const bayer=initialClubs.find(c=>c.slug==='bayer-leverkusen')!;assert.equal(bayer.balance,-2000000000);assert.equal(bayer.transferBan,true);
 assert.equal(referenceMoney('54M'),5400000000);assert.equal(referenceMoney('-20M'),-2000000000);assert.equal(referenceMoney('0'),0);assert.equal(referenceMoney('0M'),0);
 assert.throws(()=>referenceMoney('100000M'));assert.throws(()=>referenceMoney('NaN'));
 assert.deepEqual(financeCommand('!financeiro equipe juventus 54M Conferência antes da janela'),{type:'clubBalance',club:'juventus',balance:5400000000,reason:'Conferência antes da janela'});
});

test('atualização administrativa da base é absoluta, auditada e não cria saldo de empréstimo',integration,async()=>{
 const f=await fixture();try{
  await f.setup('banco','automatico');
  assert.match((await f.send('bob','!financeiro equipes')).body!,/TRANSFER BAN/);
  assert.match((await f.send('bob','!financeiro equipe juventus 70M Revisão de saldo para janela')).body!,/Somente ADMs/);
  await f.send('adm','!financeiro equipe juventus 70M Revisão de saldo para janela');
  await f.send('adm','!financeiro equipe juventus 70M Conferência final para janela');
  assert.equal((await f.pool.query("SELECT reference_balance::text FROM mlg_finance.clubs WHERE slug='juventus'")).rows[0].reference_balance,'7000000000');
  await f.send('adm','!financeiro vincular @Alice juventus','alice');
  assert.match((await f.send('adm','!financeiro vincular @Alice porto','alice')).body!,/já está vinculada/);
  await f.send('adm','!financeiro equipe bayer-leverkusen 0 Regularização do saldo da equipe');
  assert.equal((await f.pool.query("SELECT transfer_ban FROM mlg_finance.clubs WHERE slug='bayer-leverkusen'")).rows[0].transfer_ban,true);
  await f.send('adm','!financeiro transferban bayer-leverkusen nao Penalidade retirada pela administração');
  assert.equal((await f.pool.query("SELECT transfer_ban FROM mlg_finance.clubs WHERE slug='bayer-leverkusen'")).rows[0].transfer_ban,false);
  assert.equal(await f.balance('alice'),100000);
  const audited=(await f.pool.query("SELECT result FROM mlg_finance.events WHERE action='club_update' AND result->>'club'='juventus' ORDER BY at LIMIT 1")).rows[0].result;
  assert.equal(audited.before.reference_balance,'5400000000');assert.equal(audited.after.balance,7000000000);
 }finally{await f.close();}
});
