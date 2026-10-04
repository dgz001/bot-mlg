// Called only through the authenticated, private gateway by a verified MLG ADM.
type LoanQuery={query:(sql:string,params?:unknown[])=>Promise<{rows:Record<string,any>[]}>};
type LoanDatabase={transaction:<T>(run:(q:LoanQuery)=>Promise<T>)=>Promise<T>};
export async function platformLoan(db:LoanDatabase,body:Record<string,any>,identity:(q:LoanQuery,aliases:string[],name?:string)=>Promise<string>){
 if(!/^[0-9a-f-]{36}$/i.test(body.platformActor??'')||!/^\d[0-9-]*@g\.us$/.test(body.group??'')||!['get','grant','revoke'].includes(body.operation))throw Error('Invalid platform loan');
 return db.transaction(async q=>{
  const actor='platform:'+body.platformActor;
  const group=(await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[body.group])).rows[0];
  if(!group)return {error:'Autorize primeiro este grupo.'};
  const loan=(await q.query('SELECT l.*,u.display_name AS name FROM mlg_bot.loan_groups l JOIN mlg_bot.users u ON u.id=l.manager_id WHERE group_id=$1',[body.group])).rows[0];
  if(body.operation==='get'){
   const aliases=loan?(await q.query('SELECT jid FROM mlg_bot.wa_identities WHERE user_id=$1 ORDER BY verified_at DESC LIMIT 2',[loan.manager_id])).rows.map(r=>r.jid):[];
   const cup=(await q.query("SELECT * FROM mlg_bot.guest_competitions WHERE group_id=$1 AND status IN ('open','playing') ORDER BY created_at DESC LIMIT 1",[body.group])).rows[0]??null;
   const champions=(await q.query('SELECT champion_name,competition_name,edition FROM mlg_bot.loan_champions WHERE group_id=$1 ORDER BY edition DESC LIMIT 15',[body.group])).rows;
   return {loan:loan??null,aliases,cup,champions};
  }
  if((await q.query("SELECT 1 FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing') UNION SELECT 1 FROM mlg_bot.guest_competitions WHERE group_id=$1 AND status IN ('open','playing') LIMIT 1",[body.group])).rows.length)return {error:'Encerre ou cancele o campeonato ativo antes de alterar o empréstimo.'};
  await q.query('INSERT INTO mlg_bot.users(id,display_name) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor,'ADM da plataforma MLG']);
  if(body.operation==='revoke'){
   if(!loan?.active)return {error:'Não há empréstimo ativo.'};
   await q.query('UPDATE mlg_bot.loan_groups SET active=false,revoked_at=now() WHERE group_id=$1',[body.group]);
   await q.query('UPDATE mlg_bot.loan_invitations SET active=false,revoked_at=now() WHERE claimed_group=$1',[body.group]);
   await q.query("DELETE FROM mlg_bot.admins WHERE group_id=$1 AND role='channel'",[body.group]);
  }else{
   if(!Array.isArray(body.targetAliases)||!body.targetAliases.length||body.targetAliases.length>2||body.targetAliases.some((j:unknown)=>typeof j!=='string'||!/^[0-9]+@(lid|s\.whatsapp\.net)$/.test(j)))throw Error('Invalid organizer');
   if(!loan&&(await q.query('SELECT 1 FROM mlg_bot.cups WHERE group_id=$1 LIMIT 1',[body.group])).rows.length)return {error:'Este grupo tem histórico MLG; use um grupo novo.'};
   const manager=await identity(q,body.targetAliases,body.name);
   if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[manager])).rows.length)return {error:'Organizador bloqueado.'};
   if(loan?.active&&loan.manager_id!==manager)return {error:'Encerre o empréstimo anterior antes de trocar o responsável.'};
   if(loan?.active&&loan.manager_id===manager)return {updated:true,existing:true};
   const existing=(await q.query('SELECT claimed_group FROM mlg_bot.loan_invitations WHERE manager_id=$1 AND active FOR UPDATE',[manager])).rows[0];
   if(existing?.claimed_group&&existing.claimed_group!==body.group)return {error:'Este organizador já possui outro grupo emprestado.'};
   await q.query('INSERT INTO mlg_bot.loan_groups(group_id,manager_id,granted_by) VALUES($1,$2,$3) ON CONFLICT(group_id) DO UPDATE SET manager_id=excluded.manager_id,granted_by=excluded.granted_by,active=true,granted_at=now(),revoked_at=null',[body.group,manager,actor]);
   await q.query('INSERT INTO mlg_bot.loan_invitations(manager_id,granted_by,claimed_group) VALUES($1,$2,$3) ON CONFLICT(manager_id) DO UPDATE SET granted_by=excluded.granted_by,claimed_group=excluded.claimed_group,active=true,granted_at=now(),revoked_at=null',[manager,actor,body.group]);
   await q.query("INSERT INTO mlg_bot.admins(group_id,user_id,role) VALUES($1,$2,'channel') ON CONFLICT(group_id,user_id) DO NOTHING",[body.group,manager]);
   await q.query('UPDATE mlg_bot.groups SET admins_configured=true WHERE id=$1',[body.group]);
  }
  await q.query('INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES($1,$2,$3)',['platform-loan-'+body.operation,body.group,actor]);
  return {updated:true};
 });
}
