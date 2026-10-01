import {randomUUID} from 'node:crypto';
import {initialClubs,referenceDate,euroText} from './reference.ts';
import {financeCommand,financeHelp,type FinanceCommand} from './commands.ts';
import {MAX_MONEY,moneyText} from './money.ts';
export interface FinanceQuery {query<T=Record<string,any>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>}
export interface FinanceDatabase {transaction<T>(run:(q:FinanceQuery)=>Promise<T>):Promise<T>}
export type FinanceEvent={group:string;aliases:string[];targetAliases?:string[];id:string;name:string;text:string};
type Season={id:string;label:string;mode:'off'|'bank'|'peer'|'both';approval:'manual'|'auto';max_loan:string;max_debt:string;max_days:number;max_active:number;admin_group:string|null;emission_alert:string;utilization_alert:number;status:string};
type Wallet={id:string;kind:string;owner_id:string|null;eligible:boolean;max_loan?:string|null;max_debt?:string|null;max_active?:number|null};
type Loan={id:string;model:'bank'|'peer';lender:string;borrower:string;creator:string;principal:string;paid:string;days:number;status:string;expires_at:string;approval:string;approved_by:string|null;due_at:string|null};
export class FinanceError extends Error {}
function fail(message:string):never {throw new FinanceError(message);}
const exact=(value:unknown):number=>{const n=Number(value);if(!Number.isSafeInteger(n)||Math.abs(n)>MAX_MONEY)throw Error('Finance value outside safe range');return n;};
const aliasesValid=(aliases:unknown):aliases is string[]=>Array.isArray(aliases)&&aliases.length>0&&aliases.length<=2&&aliases.every(a=>typeof a==='string'&&/^\d+@(lid|s\.whatsapp\.net)$/.test(a));
async function identity(q:FinanceQuery,aliases:string[],name='Participante'):Promise<string>{
 await q.query('SELECT pg_advisory_xact_lock(71012027)');
 const known=await q.query<{user_id:string}>('SELECT DISTINCT user_id FROM mlg_bot.wa_identities WHERE jid=ANY($1::text[])',[aliases]);
 if(known.rows.length>1)fail('Contas conflitantes. Peça revisão aos ADMs; nenhuma transação foi feita.');
 const id=known.rows[0]?.user_id??randomUUID();
 const display=name.replace(/[\x00-\x1f\x7f@*_~`]/g,'').slice(0,60)||'Participante';
 await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,display]);
 for(const alias of aliases)await q.query('INSERT INTO mlg_bot.wa_identities(jid,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[alias,id]);
 return id;
}
async function wallet(q:FinanceQuery,season:string,kind:'user'|'bank'|'issuance',owner:string|null=null):Promise<Wallet>{
 const found=await q.query<Wallet>('SELECT * FROM mlg_finance.wallets WHERE season_id=$1 AND kind=$2 AND owner_id IS NOT DISTINCT FROM $3',[season,kind,owner]);
 if(found.rows[0])return found.rows[0];
 const row={id:randomUUID(),kind,owner_id:owner,eligible:true};
 await q.query('INSERT INTO mlg_finance.wallets(id,season_id,kind,owner_id) VALUES($1,$2,$3,$4)',[row.id,season,kind,owner]);return row;
}
export async function financeBalance(q:FinanceQuery,walletId:string):Promise<number>{
 const r=await q.query<{amount:string}>(`SELECT coalesce(sum(delta),0)::text AS amount FROM (
 SELECT amount AS delta FROM mlg_finance.journal WHERE destination=$1
 UNION ALL SELECT -amount FROM mlg_finance.journal WHERE source=$1) movement`,[walletId]);
 return exact(r.rows[0]!.amount);
}
async function movement(q:FinanceQuery,s:Season,event:FinanceEvent,actor:string,source:Wallet,destination:Wallet,amount:number,kind:'allocation'|'disbursement'|'repayment'|'transfer',loan:string|null,reason:string,now:number){
 if(source.kind!=='issuance'&&await financeBalance(q,source.id)<amount)fail('Saldo insuficiente. Nenhuma transferência foi feita.');
 if(await financeBalance(q,destination.id)>MAX_MONEY-amount)fail('O saldo do destinatário excederia o limite do sistema.');
 await q.query('INSERT INTO mlg_finance.journal(id,season_id,source,destination,amount,kind,loan_id,actor,message_id,reason,at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[randomUUID(),s.id,source.id,destination.id,amount,kind,loan,actor,event.id,reason,now]);
}
async function eligible(q:FinanceQuery,w:Wallet){
 const blocked=await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[w.owner_id]);
 if(!w.eligible||blocked.rows.length)fail('Conta impedida de contratar novos empréstimos. Pagamentos continuam disponíveis.');
}
async function risk(q:FinanceQuery,s:Season,borrower:Wallet,amount:number,days:number,now:number,except:string|null=null){
 await eligible(q,borrower);
 if(amount>Math.min(exact(s.max_loan),borrower.max_loan?exact(borrower.max_loan):MAX_MONEY))fail('Valor acima do limite por empréstimo desta temporada.');
 if(days>s.max_days)fail('Prazo acima do máximo desta temporada.');
 const r=await q.query<{debt:string;count:number;overdue:boolean}>(`SELECT coalesce(sum(principal-paid),0)::text AS debt,count(*)::int AS count,
 coalesce(bool_or(status='active' AND due_at<$3),false) AS overdue FROM mlg_finance.loans
 WHERE season_id=$1 AND borrower=$2 AND status IN ('pending_approval','pending_acceptance','active') AND ($4::text IS NULL OR id<>$4)`,[s.id,borrower.id,now,except]);
 const state=r.rows[0]!;
 if(state.overdue)fail('Novo empréstimo indisponível. Consulte sua situação e regularize com os ADMs no privado.');
 if(state.count>=Math.min(s.max_active,borrower.max_active??100))fail('Limite de empréstimos ativos ou propostas pendentes atingido.');
 if(exact(state.debt)>Math.min(exact(s.max_debt),borrower.max_debt?exact(borrower.max_debt):MAX_MONEY)-amount)fail('A dívida total excederia o limite desta temporada.');
}
const pending=(l:Loan)=>['pending_approval','pending_acceptance'].includes(l.status);
async function result(q:FinanceQuery,s:Season|null,event:FinanceEvent,actor:string,action:string,body:string,now:number,owners:string[]=[],details:Record<string,unknown>={}){
 const mentions=owners.length?(await q.query<{jid:string}>("SELECT DISTINCT ON(user_id) jid FROM mlg_bot.wa_identities WHERE user_id=ANY($1::text[]) AND jid LIKE '%@s.whatsapp.net' ORDER BY user_id,jid",[owners])).rows.map(r=>r.jid):[];
 await q.query('INSERT INTO mlg_finance.events(group_id,actor,message_id,season_id,action,result,at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[event.group,actor,event.id,s?.id??null,action,JSON.stringify({body,...details}),now]);
 await q.query('INSERT INTO mlg_finance.outbox(id,group_id,actor,message_id,body,mentions,available_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),event.group,actor,event.id,body.slice(0,8000),mentions,now]);
 return {duplicate:false,body};
}

export async function financeEvent(db:FinanceDatabase,event:FinanceEvent,now=Date.now()):Promise<{duplicate:boolean;body?:string}>{
 if(!/^\d[\d-]*@g\.us$/.test(event.group)||!aliasesValid(event.aliases)||event.targetAliases&&!aliasesValid(event.targetAliases)||!event.id||event.id.length>150||typeof event.text!=='string'||event.text.length>2000)throw Error('Invalid financial event');
 return db.transaction(async q=>{
  // Same group lock serializes wallets, rules, approvals and repayments. The
  // command savepoint prevents partial changes even when a domain error occurs.
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,71012028))',[event.group]);
  const group=await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized',[event.group]);
  if(!group.rows.length)fail('Grupo não autorizado.');
  const actor=await identity(q,event.aliases,event.name);
  if((await q.query('SELECT 1 FROM mlg_finance.events WHERE group_id=$1 AND actor=$2 AND message_id=$3',[event.group,actor,event.id])).rows.length)return {duplicate:true};
  let s=(await q.query<Season>("SELECT * FROM mlg_finance.seasons WHERE group_id=$1 AND status='open' FOR UPDATE",[event.group])).rows[0]??null;
  await q.query('SAVEPOINT finance_command');
  let command:FinanceCommand|null=null;
  try{
   try{command=financeCommand(event.text);}catch(error){fail(error instanceof Error?error.message:'Comando financeiro inválido.');}
   if(!command)fail('Use !financeiro ajuda.');
   const permissions=await q.query(`SELECT 1 FROM mlg_bot.admins a JOIN mlg_bot.groups g ON g.id=a.group_id
    WHERE a.user_id=$1 AND g.authorized AND g.admins_configured AND a.role IN ('owner','admin')
    AND NOT EXISTS(SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1) LIMIT 1`,[actor]);
   const admin=permissions.rows.length===1;
   const needAdmin=()=>{if(!admin)fail('Somente ADMs gerais podem administrar o financeiro.');};
   const target=async()=>{if(!event.targetAliases)fail('Marque uma única conta real deste grupo.');return identity(q,event.targetAliases);};
   if(command.type==='help')return result(q,s,event,actor,'help',financeHelp,now);
   if(command.type==='prepare'){
    needAdmin();if(s)fail('Já há uma temporada financeira aberta. Encerre-a sem dívidas antes de preparar outra.');
    if((await q.query('SELECT 1 FROM mlg_bot.loan_groups WHERE group_id=$1',[event.group])).rows.length)fail('O financeiro da MLG não pode ser preparado em grupo emprestado.');
    if((await q.query('SELECT 1 FROM mlg_finance.seasons WHERE group_id=$1 AND label=$2',[event.group,command.season])).rows.length)fail('Esta identificação de temporada já foi usada. O histórico foi preservado.');
    const id=randomUUID();await q.query('INSERT INTO mlg_finance.seasons(id,group_id,label,created_at) VALUES($1,$2,$3,$4)',[id,event.group,command.season,now]);
    s=(await q.query<Season>('SELECT * FROM mlg_finance.seasons WHERE id=$1',[id])).rows[0]!;
    await wallet(q,id,'bank');await wallet(q,id,'issuance');
    for(const club of initialClubs)await q.query('INSERT INTO mlg_finance.clubs(season_id,slug,name,reference_balance,coach_label,transfer_ban,source_date,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,club.slug,club.name,club.balance,club.coach,club.transferBan,referenceDate,now]);
    return result(q,s,event,actor,'prepare',`🗓️ Financeiro ${s.label} preparado e DESLIGADO. Saldo inicial: zero. Escolha o modelo, revise as regras e distribua o saldo virtual antes de ativar.`,now);
   }
   if((command.type==='report'||command.type==='statement'||command.type==='debts')&&command.season)s=(await q.query<Season>('SELECT * FROM mlg_finance.seasons WHERE group_id=$1 AND label=$2',[event.group,command.season])).rows[0]??null;
   if(!s)fail('Financeiro ainda não preparado. Aguarde a próxima temporada e a configuração dos ADMs.');
   // Expired proposals never reserve credit or transfer funds.
   const expired=s.status==='open'?await q.query<{id:string}>("UPDATE mlg_finance.loans SET status='expired' WHERE season_id=$1 AND status IN ('pending_approval','pending_acceptance') AND expires_at<=$2 RETURNING id",[s.id,now]):{rows:[]};
   const user=await wallet(q,s.id,'user',actor),bank=await wallet(q,s.id,'bank');
   const modeLabel=({off:'DESLIGADO',bank:'Banco virtual',peer:'Entre pessoas',both:'Ambos os modelos'} as const)[s.mode];
   if(command.type==='clubs'){
    const clubs=await q.query<{slug:string;name:string;reference_balance:string;coach_label:string;owner_id:string|null;transfer_ban:boolean}>('SELECT * FROM mlg_finance.clubs WHERE season_id=$1 ORDER BY name',[s.id]);
    return result(q,s,event,actor,'clubs',`📋 EQUIPES · ${s.label} · REFERÊNCIA PROVISÓRIA EUR\n`+clubs.rows.map(c=>`${c.name} (${c.slug}): ${euroText(exact(c.reference_balance))} · ${c.coach_label}${c.owner_id?' · WhatsApp vinculado':' · identidade ainda não vinculada'}${c.transfer_ban?' · TRANSFER BAN':''}`).join('\n')+'\nNão é saldo disponível na carteira de empréstimos MLG. Atualizações só por ADM, com histórico.',now);
   }
   if(command.type==='clubBalance'||command.type==='clubLink'||command.type==='clubBan'){
    needAdmin();const club=(await q.query<{reference_balance:string;owner_id:string|null;transfer_ban:boolean}>('SELECT * FROM mlg_finance.clubs WHERE season_id=$1 AND slug=$2',[s.id,command.club])).rows[0];
    if(!club)fail('Clube não encontrado. Use o identificador exibido em !financeiro equipes.');
    if(command.type==='clubBalance')await q.query('UPDATE mlg_finance.clubs SET reference_balance=$3,updated_at=$4 WHERE season_id=$1 AND slug=$2',[s.id,command.club,command.balance,now]);
    if(command.type==='clubBan')await q.query('UPDATE mlg_finance.clubs SET transfer_ban=$3,updated_at=$4 WHERE season_id=$1 AND slug=$2',[s.id,command.club,command.ban,now]);
    if(command.type==='clubLink'){
     const owner=await target();if((await q.query('SELECT 1 FROM mlg_finance.clubs WHERE season_id=$1 AND owner_id=$2 AND slug<>$3',[s.id,owner,command.club])).rows.length)fail('Esta pessoa já está vinculada a outro clube nesta temporada. Peça revisão aos ADMs.');
     await q.query('UPDATE mlg_finance.clubs SET owner_id=$3,updated_at=$4 WHERE season_id=$1 AND slug=$2',[s.id,command.club,owner,now]);
     return result(q,s,event,actor,'club_link','✅ Clube vinculado à identidade real marcada. O nome da lista não concede permissão administrativa nem cria saldo.',now,[owner],{club:command.club,before:club.owner_id,after:owner});
    }
    return result(q,s,event,actor,'club_update',`✅ Referência provisória de ${command.club} atualizada. Motivo: ${command.reason}. Sem movimentar carteira ou reserva do banco.`,now,[],{club:command.club,before:club,after:command});
   }
   if(command.type==='status')return result(q,s,event,actor,'status',`💰 TEMPORADA ${s.label}\nModelo: ${modeLabel}\nBanco: ${moneyText(await financeBalance(q,bank.id))}\nLimite por empréstimo: ${moneyText(exact(s.max_loan))}\nLimite total de dívida: ${moneyText(exact(s.max_debt))}\nPrazo máximo: ${s.max_days} dias · ${s.max_active} empréstimo(s)/propostas por pessoa\nBanco: aprovação ${s.approval==='manual'?'por ADM':'automática pelas regras'}\nSaldo virtual; sem juros ou multas.`,now,[],{expired:expired.rows.map(r=>r.id)});
   if(command.type==='mode'){
    needAdmin();if(command.season!==s.label)fail('A temporada informada não é a temporada aberta.');
    if(command.mode!=='off'&&!s.admin_group)fail('Configure !financeiro administracao ID_DO_GRUPO antes de ativar o financeiro.');
    if(command.mode!=='off'&&command.mode!=='both'&&(await q.query("SELECT 1 FROM mlg_finance.loans WHERE season_id=$1 AND status IN ('pending_approval','pending_acceptance','active') AND model<>$2 LIMIT 1",[s.id,command.mode])).rows.length)fail('Há propostas ou dívidas neste modelo. Não alterei o modelo.');
    await q.query('UPDATE mlg_finance.seasons SET mode=$2 WHERE id=$1',[s.id,command.mode]);
    return result(q,s,event,actor,'mode',`✅ Modelo de ${s.label}: ${command.mode}. Pausar impede novos empréstimos; pagamentos e consultas continuam disponíveis.`,now,[],{before:s.mode,after:command.mode});
   }
   if(command.type==='rules'){
    needAdmin();if(s.mode!=='off')fail('Pause o financeiro antes de alterar regras.');
    if(command.maxDebt<command.maxLoan)fail('O limite total de dívida deve ser pelo menos o limite por empréstimo.');
    await q.query('UPDATE mlg_finance.seasons SET max_loan=$2,max_debt=$3,max_days=$4,max_active=$5,approval=$6 WHERE id=$1',[s.id,command.maxLoan,command.maxDebt,command.maxDays,command.maxActive,command.approval]);
    return result(q,s,event,actor,'rules','✅ Regras registradas. Contratos existentes conservam os valores, prazos e a regra registrada na proposta. Novas confirmações também passam pelos limites atuais.',now,[],{before:s,after:command});
   }
   if(command.type==='credit'){
    needAdmin();const destination=command.bank?bank:await wallet(q,s.id,'user',await target());
    await movement(q,s,event,actor,await wallet(q,s.id,'issuance'),destination,command.amount,'allocation',null,command.reason,now);
    return result(q,s,event,actor,'credit',`✅ ${moneyText(command.amount)} de saldo virtual alocados ${command.bank?'ao banco':'à conta marcada'}. Motivo: ${command.reason}`,now,destination.owner_id?[destination.owner_id]:[],{amount:command.amount,destination:destination.id,reason:command.reason});
   }
   if(command.type==='eligibility'){
    needAdmin();const w=await wallet(q,s.id,'user',await target());await q.query('UPDATE mlg_finance.wallets SET eligible=$2 WHERE id=$1',[w.id,command.eligible]);
    return result(q,s,event,actor,'eligibility',`✅ Novos empréstimos ${command.eligible?'liberados':'bloqueados'} para a conta marcada. Pagamentos continuam permitidos. Motivo: ${command.reason}`,now,[w.owner_id!],{before:w.eligible,after:command.eligible,target:w.owner_id,reason:command.reason});
   }
   if(command.type==='administration'){
    needAdmin();if(!(await q.query('SELECT 1 FROM mlg_bot.groups WHERE id=$1 AND authorized AND admins_configured',[command.group])).rows.length)fail('Escolha um grupo autorizado com administração cadastrada.');
    await q.query('UPDATE mlg_finance.seasons SET admin_group=$2 WHERE id=$1',[s.id,command.group]);
    return result(q,s,event,actor,'administration','✅ Grupo administrativo de cobrança registrado. Vencimentos serão avisados lá e no privado do devedor.',now,[],{group:command.group});
   }
   if(command.type==='limits'){
    needAdmin();if(command.maxDebt<command.maxLoan)fail('O limite total deve ser pelo menos o limite por empréstimo.');
    const w=await wallet(q,s.id,'user',await target());
    await q.query('UPDATE mlg_finance.wallets SET max_loan=$2,max_debt=$3,max_active=$4 WHERE id=$1',[w.id,command.maxLoan,command.maxDebt,command.maxActive]);
    return result(q,s,event,actor,'limits','✅ Limites individuais registrados. Valem também os limites gerais mais restritivos. Contratos anteriores continuam registrados.',now,[w.owner_id!],{target:w.owner_id,...command});
   }
   if(command.type==='alerts'){
    needAdmin();await q.query('UPDATE mlg_finance.seasons SET emission_alert=$2,utilization_alert=$3 WHERE id=$1',[s.id,command.emission,command.utilization]);
    return result(q,s,event,actor,'alerts','✅ Alertas de emissão diária e utilização do banco configurados. São sinais de risco; inflação exige dados de preços.',now,[],{...command});
   }
   if(command.type==='transfer'){
    await eligible(q,user);const destination=await wallet(q,s.id,'user',await target());
    if(destination.id===user.id)fail('Não é possível transferir para a própria conta.');
    await movement(q,s,event,actor,user,destination,command.amount,'transfer',null,command.reason,now);
    return result(q,s,event,actor,'transfer',`✅ Transferência de ${moneyText(command.amount)} registrada. Motivo: ${command.reason}`,now,[destination.owner_id!],{amount:command.amount,destination:destination.id});
   }
   if(command.type==='ranking'){
    const page=command.page;needAdmin();const rows=await q.query<{name:string;total:string;remaining:string;count:number}>(`SELECT u.display_name AS name,sum(l.principal)::text AS total,sum(l.principal-l.paid)::text AS remaining,count(*)::int AS count FROM mlg_finance.loans l JOIN mlg_finance.wallets w ON w.id=l.borrower JOIN mlg_bot.users u ON u.id=w.owner_id WHERE l.season_id=$1 AND l.status IN ('active','repaid') GROUP BY u.id,u.display_name ORDER BY sum(l.principal) DESC,u.id LIMIT 11 OFFSET $2`,[s.id,(command.page-1)*10]);
    return result(q,s,event,actor,'ranking',`📊 QUEM TOMOU EMPRÉSTIMOS · ${s.label} · página ${command.page}\n`+(rows.rows.slice(0,10).map((v,i)=>`${(page-1)*10+i+1}. ${v.name}: ${moneyText(BigInt(v.total))} · ${v.count} empréstimo(s) · devolver ${moneyText(BigInt(v.remaining))}`).join('\n')||'Nenhum empréstimo confirmado.')+(rows.rows.length>10?'\nPróxima: !financeiro ranking '+(command.page+1):''),now);
   }
   if(command.type==='balance')return result(q,s,event,actor,'balance',`💰 Seu saldo virtual: ${moneyText(await financeBalance(q,user.id))}\nTemporada: ${s.label}. Dívidas são consultadas com !financeiro dividas.`,now);
   if(command.type==='statement'){
    const rows=await q.query<{kind:string;amount:string;source:string;loan_id:string|null;at:string}>(`SELECT kind,amount::text,source,loan_id,at::text FROM mlg_finance.journal WHERE season_id=$1 AND (source=$2 OR destination=$2) ORDER BY at DESC,id DESC LIMIT 11 OFFSET $3`,[s.id,user.id,(command.page-1)*10]);
    return result(q,s,event,actor,'statement',`📒 EXTRATO · ${s.label} · página ${command.page}\nSaldo: ${moneyText(await financeBalance(q,user.id))}\n`+(rows.rows.slice(0,10).map(r=>`${r.source===user.id?'-':'+'}${moneyText(exact(r.amount))} · ${r.kind} · ${r.loan_id??'alocação'} · ${new Date(Number(r.at)).toISOString().slice(0,10)}`).join('\n')||'Nenhuma movimentação.')+(rows.rows.length>10?'\nPara continuar: !financeiro extrato '+(command.page+1):''),now);
   }
   if(command.type==='debts'||command.type==='report'){
    const report=command.type==='report';if(report)needAdmin();
    const rows=await q.query<Loan&{borrower_name:string;lender_name:string}>(`SELECT l.*,bu.display_name AS borrower_name,coalesce(lu.display_name,'Banco') AS lender_name FROM mlg_finance.loans l JOIN mlg_finance.wallets bw ON bw.id=l.borrower JOIN mlg_bot.users bu ON bu.id=bw.owner_id JOIN mlg_finance.wallets lw ON lw.id=l.lender LEFT JOIN mlg_bot.users lu ON lu.id=lw.owner_id WHERE l.season_id=$1 AND ($2::boolean OR l.lender=$3 OR l.borrower=$3) ORDER BY l.created_at DESC,l.id DESC LIMIT 11 OFFSET $4`,[s.id,report,user.id,(command.page-1)*10]);
    const totals=await q.query<{principal:string;remaining:string;active:number;pending:number}>(`SELECT coalesce(sum(principal) FILTER(WHERE status IN ('active','repaid')),0)::text AS principal,coalesce(sum(principal-paid) FILTER(WHERE status='active'),0)::text AS remaining,count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE status IN ('pending_approval','pending_acceptance'))::int AS pending FROM mlg_finance.loans WHERE season_id=$1 AND ($2::boolean OR lender=$3 OR borrower=$3)`,[s.id,report,user.id]);
    const total=totals.rows[0]!;
    const detail=rows.rows.slice(0,10).map(l=>`${l.id} · ${l.lender_name} → ${l.borrower_name} · ${l.model} · ${l.status} · ${moneyText(exact(l.principal))} · devolvido ${moneyText(exact(l.paid))}${l.due_at?' · vence '+new Date(Number(l.due_at)).toISOString().slice(0,10):''}${l.status==='active'&&Number(l.due_at)<now?' · VENCIDO':''}`).join('\n');
    return result(q,s,event,actor,report?'report':'debts',`📊 ${report?'RELATÓRIO':'SEUS EMPRÉSTIMOS'} · ${s.label} · página ${command.page}\nAtivos: ${total.active} · propostas: ${total.pending}\nTotal emprestado: ${moneyText(BigInt(total.principal))} · saldo a devolver: ${moneyText(BigInt(total.remaining))}\n`+(detail||'Nenhum empréstimo registrado.')+(rows.rows.length>10?'\nPróxima: !financeiro '+(report?'relatorio ':'dividas ')+(command.page+1):''),now);
   }
   if(command.type==='close'){
    needAdmin();if(command.season!==s.label)fail('Confirme a identificação da temporada aberta.');
    if((await q.query("SELECT 1 FROM mlg_finance.loans WHERE season_id=$1 AND status IN ('pending_approval','pending_acceptance','active') LIMIT 1",[s.id])).rows.length)fail('Há propostas ou dívidas. Cancele as propostas e quite os empréstimos antes de encerrar.');
    await q.query("UPDATE mlg_finance.seasons SET status='closed',mode='off',closed_at=$2 WHERE id=$1",[s.id,now]);
    return result(q,s,event,actor,'close',`✅ Financeiro ${s.label} encerrado. Saldos, contratos, confirmações e extrato foram preservados. Uma temporada nova começa com saldo zero.`,now);
   }
   if(command.type==='offer'||command.type==='request'){
    const model=command.type==='offer'?'peer':'bank';
    if(s.mode!=='both'&&s.mode!==model)fail('Este modelo está desativado nesta temporada.');
    const borrower=model==='bank'?user:await wallet(q,s.id,'user',await target());
    const lender=model==='bank'?bank:user;
    if(lender.id===borrower.id)fail('Você não pode emprestar para a própria conta.');
    if(model==='peer')await eligible(q,lender);
    await risk(q,s,borrower,command.amount,command.days,now);
    if(await financeBalance(q,lender.id)<command.amount)fail('Saldo do credor insuficiente para a proposta.');
    const id='F'+randomUUID().replaceAll('-','').slice(0,10).toUpperCase(),approval=model==='peer'?'peer':s.approval;
    const status=approval==='manual'?'pending_approval':'pending_acceptance';
    const snapshot={maxLoan:exact(s.max_loan),maxDebt:exact(s.max_debt),maxDays:s.max_days,maxActive:s.max_active,approval,interest:0};
    await q.query('INSERT INTO mlg_finance.loans(id,season_id,model,lender,borrower,creator,principal,days,status,approval,rule_snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)',[id,s.id,model,lender.id,borrower.id,actor,command.amount,command.days,status,approval,JSON.stringify(snapshot),now,now+86400000]);
    return result(q,s,event,actor,'proposal',`💰 PROPOSTA ${id}\nModelo: ${model==='bank'?'banco virtual':'entre pessoas'}\nValor: ${moneyText(command.amount)} · prazo: ${command.days} dias após a confirmação\nSem juros ou multas. Nenhum saldo foi transferido ainda.\n`+(approval==='manual'?`Aguarda outro ADM: !financeiro aprovar ${id}. Depois, o solicitante confirma com !sim ${id}.`:`A conta que receberá o saldo deve responder !sim ${id} ou !nao ${id}.`)+`\nExpira em 24 horas. O saldo e os limites serão conferidos novamente na confirmação.`,now,[borrower.owner_id!],{loan:id,...snapshot});
   }
   const c=command as Extract<FinanceCommand,{code:string}>;
   const l=(await q.query<Loan>('SELECT * FROM mlg_finance.loans WHERE id=$1 AND season_id=$2 FOR UPDATE',[c.code,s.id])).rows[0];
   if(!l)fail('Empréstimo não encontrado nesta temporada e neste grupo.');
   const lender=(await q.query<Wallet>('SELECT * FROM mlg_finance.wallets WHERE id=$1',[l.lender])).rows[0]!;
   const borrower=(await q.query<Wallet>('SELECT * FROM mlg_finance.wallets WHERE id=$1',[l.borrower])).rows[0]!;
   if(c.type==='approve'){
    needAdmin();if(l.status!=='pending_approval')fail('Esta proposta não está aguardando aprovação do banco.');
    if(actor===l.creator)fail('Outro ADM deve aprovar seu próprio pedido ao banco.');
    if(s.mode!=='bank'&&s.mode!=='both')fail('O banco está pausado.');
    await risk(q,s,borrower,exact(l.principal),l.days,now,l.id);
    if(await financeBalance(q,lender.id)<exact(l.principal))fail('Banco sem saldo para aprovar a proposta.');
    await q.query("UPDATE mlg_finance.loans SET status='pending_acceptance',approved_by=$2 WHERE id=$1",[l.id,actor]);
    return result(q,s,event,actor,'approve',`✅ Banco aprovou ${l.id}: ${moneyText(exact(l.principal))} por ${l.days} dias, sem juros. Solicitante: !sim ${l.id} ou !nao ${l.id}. Nenhum saldo foi transferido ainda.`,now,[borrower.owner_id!],{loan:l.id});
   }
   if(c.type==='reject'||c.type==='cancel'){
    if(c.type==='reject'&&actor!==borrower.owner_id)fail('Só quem receberia o saldo pode recusar esta proposta.');
    if(c.type==='cancel'&&actor!==l.creator&&actor!==borrower.owner_id&&!admin)fail('Você não pode cancelar a proposta de outras contas.');
    if(!pending(l))fail('Só propostas pendentes podem ser recusadas ou canceladas.');
    await q.query('UPDATE mlg_finance.loans SET status=$2 WHERE id=$1',[l.id,c.type==='reject'?'rejected':'cancelled']);
    return result(q,s,event,actor,c.type,`✅ Proposta ${l.id} ${c.type==='reject'?'recusada':'cancelada'}. Nenhum saldo foi transferido.`,now,[],{loan:l.id});
   }
   if(c.type==='accept'){
    if(actor!==borrower.owner_id)fail('Só a conta que receberá o saldo pode confirmar este código.');
    if(l.status!=='pending_acceptance')fail('A proposta não está disponível para aceitar: pode estar aguardando ADM, concluída, cancelada ou vencida.');
    if(s.mode!=='both'&&s.mode!==l.model)fail('Este modelo está pausado. Nenhum saldo foi transferido.');
    if(lender.kind==='user')await eligible(q,lender);
    await risk(q,s,borrower,exact(l.principal),l.days,now,l.id);
    await movement(q,s,event,actor,lender,borrower,exact(l.principal),'disbursement',l.id,'Confirmação da proposta '+l.id,now);
    const due=now+l.days*86400000;
    await q.query("UPDATE mlg_finance.loans SET status='active',accepted_at=$2,due_at=$3 WHERE id=$1",[l.id,now,due]);
    return result(q,s,event,actor,'accept',`✅ EMPRÉSTIMO ${l.id} CONFIRMADO\n${moneyText(exact(l.principal))} transferidos em saldo virtual.\nVencimento: ${new Date(due).toISOString().slice(0,10)} UTC.\nValor a devolver: ${moneyText(exact(l.principal))}. Sem juros.\nPagamento: !financeiro pagar ${l.id} VALOR. Confirmação e movimentação registradas.`,now,[borrower.owner_id!,...(lender.owner_id?[lender.owner_id]:[])],{loan:l.id,amount:exact(l.principal),dueAt:due});
   }
   if(c.type==='pay'){
    if(actor!==borrower.owner_id)fail('Só o devedor pode pagar este empréstimo com o próprio saldo.');
    if(l.status!=='active')fail('Este empréstimo não tem dívida ativa para pagar.');
    const remaining=exact(l.principal)-exact(l.paid);
    if(c.amount>remaining)fail('O pagamento excede o saldo devedor.');
    await movement(q,s,event,actor,borrower,lender,c.amount,'repayment',l.id,'Pagamento de '+l.id,now);
    const paid=exact(l.paid)+c.amount;
    await q.query('UPDATE mlg_finance.loans SET paid=$2,status=$3 WHERE id=$1',[l.id,paid,paid===exact(l.principal)?'repaid':'active']);
    return result(q,s,event,actor,'pay',`✅ ${l.id}: pagamento de ${moneyText(c.amount)} registrado.\nRestante: ${moneyText(exact(l.principal)-paid)}.${paid===exact(l.principal)?' Empréstimo quitado.':''}`,now,[],{loan:l.id,amount:c.amount,remaining:exact(l.principal)-paid});
   }
   fail('Comando financeiro inválido.');
  }catch(error){
   if(!(error instanceof FinanceError))throw error;
   await q.query('ROLLBACK TO SAVEPOINT finance_command');
   const response=await result(q,s,event,actor,'refused','⚠️ '+error.message,now,[],{requested:command?.type??'invalid'});
   if(command&&['request','offer','accept'].includes(command.type)){
    const recipientAliases=command.type==='offer'?event.targetAliases:event.aliases;
    const recipient=recipientAliases?.find(j=>j.endsWith('@s.whatsapp.net'))??recipientAliases?.[0];
    if(recipient)await q.query('INSERT INTO mlg_finance.outbox(id,group_id,recipient,actor,message_id,body,available_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),event.group,recipient,actor,event.id,'🔔 Aviso privado: '+error.message+' Nenhum saldo foi transferido. Converse com os ADMs para revisar seus limites.',now]);
   }
   return response;
  }
 });
}

export async function financePoll(db:FinanceDatabase,now=Date.now()){
 return db.transaction(async q=>{
  await monitorFinance(q,now);
  await q.query("UPDATE mlg_finance.outbox SET status='failed' WHERE status='sending' AND attempts>=10 AND lease_until<=$1",[now]);
  const rows=await q.query<{id:string;group_id:string;recipient:string|null;body:string;mentions:string[]}>(`SELECT id,group_id,recipient,body,mentions FROM mlg_finance.outbox WHERE attempts<10 AND
   (status='pending' AND available_at<=$1 OR status='sending' AND lease_until<=$1) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 5`,[now]);
  const messages=[];
  for(const row of rows.rows){const lease=randomUUID();await q.query("UPDATE mlg_finance.outbox SET status='sending',attempts=attempts+1,lease=$2,lease_until=$3 WHERE id=$1",[row.id,lease,now+90000]);messages.push({...row,lease});}
  return {messages};
 });
}
export async function financeAck(db:FinanceDatabase,id:string,lease:string,sent:boolean,now=Date.now()){
 return db.transaction(async q=>{
  const changed=await q.query(`UPDATE mlg_finance.outbox SET status=CASE WHEN $3 THEN 'sent' WHEN attempts>=10 THEN 'failed' ELSE 'pending' END,
   lease_until=NULL,available_at=$4 WHERE id=$1 AND lease=$2 AND status='sending' RETURNING id`,[id,lease,sent,now+30000]);
  return {acknowledged:changed.rows.length===1};
 });
}

async function monitorFinance(q:FinanceQuery,now:number){
 const seasons=await q.query<Season&{group_id:string}>("SELECT s.* FROM mlg_finance.seasons s JOIN mlg_bot.groups g ON g.id=s.group_id WHERE s.status='open' AND g.authorized AND s.monitored_at<=$1 ORDER BY s.id FOR UPDATE OF s SKIP LOCKED LIMIT 5",[now-3600000]);
 for(const s of seasons.rows){
  await q.query('UPDATE mlg_finance.seasons SET monitored_at=$2 WHERE id=$1',[s.id,now]);
  const day=Math.floor(now/86400000);
  const notify=async(actor:string,key:string,body:string,destinations:(string|null)[],action:string)=>{
   const id='monitor-'+s.id+'-'+key+'-'+day;
   if((await q.query('SELECT 1 FROM mlg_finance.events WHERE group_id=$1 AND actor=$2 AND message_id=$3',[s.group_id,actor,id])).rows.length)return;
   await q.query('INSERT INTO mlg_finance.events(group_id,actor,message_id,season_id,action,result,at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[s.group_id,actor,id,s.id,action,JSON.stringify({body}),now]);
   for(const recipient of destinations)await q.query('INSERT INTO mlg_finance.outbox(id,group_id,recipient,actor,message_id,body,available_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),s.group_id,recipient,actor,id,body,now]);
  };
  const overdue=await q.query<{id:string;owner_id:string;display_name:string;principal:string;paid:string;due_at:string;jid:string|null}>(`SELECT l.id,w.owner_id,u.display_name,l.principal::text,l.paid::text,l.due_at::text,(SELECT jid FROM mlg_bot.wa_identities WHERE user_id=w.owner_id ORDER BY (jid LIKE '%@s.whatsapp.net') DESC,jid LIMIT 1) AS jid FROM mlg_finance.loans l JOIN mlg_finance.wallets w ON w.id=l.borrower JOIN mlg_bot.users u ON u.id=w.owner_id WHERE l.season_id=$1 AND l.status='active' AND l.due_at<$2 AND NOT EXISTS(SELECT 1 FROM mlg_finance.events e WHERE e.group_id=$3 AND e.actor=w.owner_id AND e.message_id='monitor-'||$1::text||'-overdue-'||l.id||'-'||$4::text) ORDER BY l.due_at,l.id LIMIT 50`,[s.id,now,s.group_id,day]);
  for(const l of overdue.rows){
   const body=`🔔 Lembrete privado · ${s.label}\nEmpréstimo ${l.id} de ${l.display_name}: ${moneyText(BigInt(l.principal)-BigInt(l.paid))} a devolver. Venceu em ${new Date(Number(l.due_at)).toISOString().slice(0,10)} UTC.\nPagamento: !financeiro pagar ${l.id} VALOR no grupo de empréstimos. Se precisar, converse com os ADMs. Sem multa automática.`;
   const destinations=[l.jid,s.admin_group].filter((v):v is string=>Boolean(v));
   if(destinations.length)await notify(l.owner_id,'overdue-'+l.id,body,destinations,'overdue_notice');
  }
  const emission=await q.query<{total:string;actor:string|null}>(`SELECT coalesce(sum(amount),0)::text AS total,(array_agg(actor ORDER BY at DESC,id DESC))[1] AS actor FROM mlg_finance.journal WHERE season_id=$1 AND kind='allocation' AND at>=$2`,[s.id,day*86400000]);
  const loans=await q.query<{debt:string;actor:string|null}>(`SELECT coalesce(sum(principal-paid),0)::text AS debt,(array_agg(creator ORDER BY created_at DESC,id DESC))[1] AS actor FROM mlg_finance.loans WHERE season_id=$1 AND model='bank' AND status='active'`,[s.id]);
  const bank=await wallet(q,s.id,'bank'),balance=await financeBalance(q,bank.id),debt=BigInt(loans.rows[0]!.debt),emitted=BigInt(emission.rows[0]!.total);
  const highEmission=emitted>=BigInt(s.emission_alert),highUtilization=debt>0n&&debt*100n>=(debt+BigInt(balance))*BigInt(s.utilization_alert);
  const actor=emission.rows[0]!.actor??loans.rows[0]!.actor;
  if(actor&&(highEmission||highUtilization)){
   const body=`⚠️ ALERTA ECONÔMICO · ${s.label}\n${highEmission?'Emissão de saldo hoje: '+moneyText(emitted)+'; limite de alerta '+moneyText(BigInt(s.emission_alert))+'.\n':''}${highUtilization?'Crédito em aberto atingiu '+s.utilization_alert+'% ou mais dos recursos do banco.\n':''}Saldo disponível do banco: ${moneyText(balance)}. ADMs: revisem emissão, preços e regras. Este sinal não comprova inflação.`;
   const recipient=(await q.query<{jid:string}>("SELECT jid FROM mlg_bot.wa_identities WHERE user_id=$1 ORDER BY (jid LIKE '%@s.whatsapp.net') DESC,jid LIMIT 1",[actor])).rows[0]?.jid;
   await notify(actor,'economic',body,[null,...(s.admin_group?[s.admin_group]:[]),...(recipient?[recipient]:[])],'economic_alert');
  }
 }
}
