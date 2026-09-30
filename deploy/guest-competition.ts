// @ts-nocheck — Edge runtime module is exercised against disposable PostgreSQL.
import {randomInt,randomUUID} from 'node:crypto';

const safeScore=(s:string)=>{const m=s.match(/^(\d{1,2})[xX×](\d{1,2})$/);return m?[Number(m[1]),Number(m[2])]:null;};
const numbered=async(q)=>Number((await q.query("UPDATE mlg_bot.counters SET next_code=next_code+1 WHERE id='match' RETURNING next_code")).rows[0].next_code)-1;
const notify=async(q,group,user,message,body)=>{
 await q.query('INSERT INTO mlg_bot.outbox(group_id,user_id,message_id,ordinal,body) VALUES($1,$2,$3,0,$4)',[group,user,message,body.slice(0,8000)]);
};
const audit=async(q,cup,match,user,action,before,after,reason=null)=>q.query(`INSERT INTO mlg_bot.guest_result_audit(cup_id,code,actor,action,before_score,after_score,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,[cup.id,match.code,user,action,before,after,reason]);
const names=(players)=>new Map(players.map(p=>[p.user_id,p.display_name]));
const score=(m)=>`${m.home_score}x${m.away_score}`;
const card=(m,people)=>`#${m.code} · ${m.leg===3?'desempate':m.leg===2?'volta':'ida'} · ${people.get(m.home)} × ${people.get(m.away)}${m.status==='confirmed'?' · '+score(m):m.status==='pending'?' · aguardando confirmação':m.status==='disputed'?' · contestado':''}`;
export const guestStandings=(players,matches)=>{
 const rows=players.map(p=>({id:p.user_id,name:p.display_name,team:p.team,played:0,wins:0,draws:0,goals:0,against:0,points:0}));
 const byId=new Map(rows.map(p=>[p.id,p]));
 for(const m of matches.filter(m=>m.status==='confirmed')){
  const h=byId.get(m.home),a=byId.get(m.away);if(!h||!a)continue;
  h.played++;a.played++;h.goals+=m.home_score;a.goals+=m.away_score;h.against+=m.away_score;a.against+=m.home_score;
  if(m.home_score===m.away_score){h.draws++;a.draws++;h.points++;a.points++;}
  else if(m.home_score>m.away_score){h.wins++;h.points+=3;}else{a.wins++;a.points+=3;}
 }
 rows.sort((a,b)=>b.points-a.points||(b.goals-b.against)-(a.goals-a.against)||b.goals-a.goals||b.wins-a.wins||a.name.localeCompare(b.name,'pt-BR'));
 return rows;
};
const standingsText=(rows)=>rows.map((p,i)=>`${i+1}. ${p.name} (${p.team}) · ${p.points} pts · J${p.played} V${p.wins} E${p.draws} · SG${p.goals-p.against} GP${p.goals}`).join('\n');
export function guestFixtures(mode,legs,ids){
 const fixtures=[];
 if(mode==='liga'){
  const rotation=ids.length%2?[...ids,null]:[...ids];const count=rotation.length,cycles=count-1;
  for(let round=0;round<cycles;round++){
   for(let position=0;position<count/2;position++){
    const a=rotation[position],b=rotation[count-1-position];if(!a||!b)continue;
    const home=(round+position)%2?a:b,away=home===a?b:a;
    for(let leg=1;leg<=legs;leg++)fixtures.push({round:round+(leg-1)*cycles,position,leg,home:leg===1?home:away,away:leg===1?away:home});
   }
   rotation.splice(1,0,rotation.pop());
  }
 }else{
  for(let position=0;position<ids.length/2;position++)for(let leg=1;leg<=legs;leg++)fixtures.push({round:0,position,leg,home:ids[position*2+(leg===2?1:0)],away:ids[position*2+(leg===2?0:1)]});
 }
 return fixtures;
}
async function schedule(q,cup,players){
 const ids=players.map(p=>p.user_id);
 for(let i=ids.length-1;i>0;i--){const j=randomInt(i+1);[ids[i],ids[j]]=[ids[j],ids[i]];}
 for(const m of guestFixtures(cup.mode,cup.legs,ids))await q.query(`INSERT INTO mlg_bot.guest_matches(code,cup_id,round,position,leg,home,away,status)
 VALUES($1,$2,$3,$4,$5,$6,$7,'scheduled')`,[await numbered(q),cup.id,m.round,m.position,m.leg,m.home,m.away]);
}
async function createTie(q,cup,round,position,home,away){
 for(let leg=1;leg<=cup.legs;leg++)await q.query(`INSERT INTO mlg_bot.guest_matches(code,cup_id,round,position,leg,home,away,status)
 VALUES($1,$2,$3,$4,$5,$6,$7,'scheduled')`,[await numbered(q),cup.id,round,position,leg,leg===1?home:away,leg===1?away:home]);
}
async function progress(q,cup,players,group){
 const matches=(await q.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 ORDER BY round,position,leg',[cup.id])).rows;
 if(cup.mode==='liga'){
  if(matches.some(m=>m.status!=='confirmed'))return '';
  const table=guestStandings(players,matches.filter(m=>m.leg!==3));
  const same=(a,b)=>a.points===b.points&&a.goals-a.against===b.goals-b.against&&a.goals===b.goals&&a.wins===b.wins;
  const leaders=table.filter(p=>same(p,table[0]));
  let winner=leaders[0];
  if(leaders.length>1){
   let resolved=false;
   const playoffs=matches.filter(m=>m.leg===3),latest=Math.max(...playoffs.map(m=>m.round),-1);
   const cycle=playoffs.filter(m=>m.round===latest);
   if(cycle.length){
    const playoffTable=guestStandings(players.filter(p=>cycle.some(m=>m.home===p.user_id||m.away===p.user_id)),cycle);
    const top=playoffTable.filter(p=>same(p,playoffTable[0]));
    if(top.length===1){winner=top[0];resolved=true;}
    else leaders.splice(0,leaders.length,...top);
   }
   if(!resolved){
    const nextRound=Math.max(...matches.map(m=>m.round))+1;
    for(let i=0,position=0;i<leaders.length;i++)for(let j=i+1;j<leaders.length;j++,position++)await q.query("INSERT INTO mlg_bot.guest_matches(code,cup_id,round,position,leg,home,away,status) VALUES($1,$2,$3,$4,3,$5,$6,'scheduled')",[await numbered(q),cup.id,nextRound,position,leaders[i].id,leaders[j].id]);
    return '⚖️ Empate total na liderança. Jogos de desempate criados entre os empatados. Veja !copa.';
   }
  }
  await q.query("UPDATE mlg_bot.guest_competitions SET status='completed',champion_id=$2,completed_at=$3 WHERE id=$1",[cup.id,winner.id,Date.now()]);
  return '🏆 CAMPEÃO · '+players.find(p=>p.user_id===winner.id).display_name+'\n\n'+standingsText(table)+'\n\nO campeão fica registrado em !campeoes.';
 }
 for(let round=0;round<Math.log2(cup.size);round++){
  const games=matches.filter(m=>m.round===round);
  if(games.length<cup.size/2**(round+1)*cup.legs)return '';
  const winners=[];
  for(let position=0;position<cup.size/2**(round+1);position++){
   const tie=games.filter(m=>m.position===position),first=tie.find(m=>m.leg===1),second=tie.find(m=>m.leg===2),decider=tie.find(m=>m.leg===3);
   if(!first||first.status!=='confirmed'||cup.legs===2&&(!second||second.status!=='confirmed'))return '';
   const a=first.home,b=first.away;
   const goalsA=first.home_score+(second?(second.home===a?second.home_score:second.away_score):0);
   const goalsB=first.away_score+(second?(second.home===b?second.home_score:second.away_score):0);
   if(goalsA===goalsB){
    if(!decider){await q.query("INSERT INTO mlg_bot.guest_matches(code,cup_id,round,position,leg,home,away,status) VALUES($1,$2,$3,$4,3,$5,$6,'scheduled')",[await numbered(q),cup.id,round,position,a,b]);return '⚖️ Agregado empatado. Um jogo de desempate foi criado. Veja o código em !copa.';}
    if(decider.status!=='confirmed')return '';
    if(decider.home_score===decider.away_score)return '⚖️ O desempate precisa de vencedor.';
    winners.push(decider.home_score>decider.away_score?decider.home:decider.away);
   }else winners.push(goalsA>goalsB?a:b);
  }
  if(winners.length===1){
   const winner=players.find(p=>p.user_id===winners[0]);
   await q.query("UPDATE mlg_bot.guest_competitions SET status='completed',champion_id=$2,completed_at=$3 WHERE id=$1",[cup.id,winner.user_id,Date.now()]);
   return '🏆 CAMPEÃO · '+winner.display_name+' ('+winner.team+'). O título fica em !campeoes.';
  }
  if(!matches.some(m=>m.round===round+1)){
   for(let i=0;i<winners.length/2;i++)await createTie(q,cup,round+1,i,winners[2*i],winners[2*i+1]);
   return '⚔️ Próxima fase formada! Os novos confrontos e códigos estão em !copa.';
  }
 }
 return '';
}

export async function guestOpen(db,request){
 const {group,name,mode,legs,size,teams}=request;
 if(!/^[0-9-]+@g\.us$/.test(group)||typeof name!=='string'||name.length<3||name.length>60||!['liga','copa'].includes(mode)||![1,2].includes(legs)||!Number.isInteger(size)||size<2||size>16&&!(mode==='copa'&&size===32)||mode==='copa'&&![4,8,16,32].includes(size)||!Array.isArray(teams)||teams.length<size||teams.length>200||new Set(teams.map(t=>t.toLocaleLowerCase('pt-BR'))).size!==teams.length||teams.some(t=>typeof t!=='string'||t.length<2||t.length>60||/[\r\n\x00-\x1f\x7f*_~`]/.test(t)))throw Error('Invalid guest competition');
 return db.transaction(async q=>{
  const owner=(await q.query('SELECT manager_id FROM mlg_bot.loan_groups WHERE group_id=$1 AND active',[group])).rows[0];
  if(!owner)return {error:'Empréstimo não está ativo neste grupo.'};
  await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[group]);
  if((await q.query("SELECT 1 FROM mlg_bot.guest_competitions WHERE group_id=$1 AND status IN ('open','playing')",[group])).rows.length||(await q.query("SELECT 1 FROM mlg_bot.cups WHERE group_id=$1 AND status IN ('open','playing')",[group])).rows.length)return {error:'Há um campeonato em andamento neste grupo.'};
  const id=randomUUID();await q.query("INSERT INTO mlg_bot.guest_competitions(id,group_id,name,mode,legs,size,status,created_at) VALUES($1,$2,$3,$4,$5,$6,'open',$7)",[id,group,name.trim(),mode,legs,size,Date.now()]);
  await q.query('DELETE FROM mlg_bot.club_pool WHERE group_id=$1',[group]);for(const team of teams)await q.query('INSERT INTO mlg_bot.club_pool(group_id,name) VALUES($1,$2)',[group,team]);
  await q.query('UPDATE mlg_bot.groups SET competition_name=$2 WHERE id=$1',[group,name.trim()]);
  await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('guest-open',$1,$2)",[group,owner.manager_id]);
  return {opened:true,id};
 });
}

export async function guestEvent(db,request,identity){
 const {group,aliases,messageId,text,name}=request;
 if(!/^[0-9-]+@g\.us$/.test(group)||!Array.isArray(aliases)||typeof messageId!=='string'||messageId.length>150||typeof text!=='string'||text.length>1000)throw Error('Invalid guest event');
 return db.transaction(async q=>{
  const user=await identity(q,aliases,name);
  await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 AND authorized FOR UPDATE',[group]);
  const loan=(await q.query('SELECT manager_id FROM mlg_bot.loan_groups WHERE group_id=$1 AND active',[group])).rows[0];
  if(!loan)return {accepted:false};
  if((await q.query('SELECT 1 FROM mlg_bot.member_blocks WHERE user_id=$1',[user])).rows.length)return {accepted:false};
  const seen=await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id',[group,user,messageId,Date.now()]);
  if(!seen.rows.length)return {accepted:true,duplicate:true};
  const rate=await q.query(`INSERT INTO mlg_bot.command_rate(group_id,user_id,window_start,count) VALUES($1,$2,now(),1)
   ON CONFLICT(group_id,user_id) DO UPDATE SET count=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN 1 ELSE command_rate.count+1 END,
   window_start=CASE WHEN command_rate.window_start<now()-interval '1 minute' THEN now() ELSE command_rate.window_start END RETURNING count`,[group,user]);
  if(rate.rows[0].count>30)return {accepted:true,rateLimited:true};
  const cup=(await q.query("SELECT * FROM mlg_bot.guest_competitions WHERE group_id=$1 AND status IN ('open','playing','completed') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[group])).rows[0];
  const players=cup?(await q.query('SELECT * FROM mlg_bot.guest_players WHERE cup_id=$1 ORDER BY position',[cup.id])).rows:[];
  const matches=cup?(await q.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 ORDER BY round,position,leg',[cup.id])).rows:[];
  const people=names(players),admin=user===loan.manager_id||(await q.query("SELECT 1 FROM mlg_bot.admins WHERE user_id=$1 AND role IN ('owner','admin') LIMIT 1",[user])).rows.length>0;
  const [command,...args]=text.trim().split(/\s+/),cmd=command.toLocaleLowerCase('pt-BR');
  const n=Number(args[0]),selected=matches.find(m=>m.code===n);
  let reply='Comando não reconhecido. Use !ajuda.';
  if(cmd==='!ajuda'||cmd==='!comandos')reply='🏆 '+(cup?.name??'CAMPEONATO')+'\n!entrar · !sair (antes do sorteio)\n!copa · !meujogo · !tabela · !classificacao · !proximafase\n!resultado CÓDIGO MxV (mandante primeiro)\n!confirmar CÓDIGO MxV · !cancelar CÓDIGO · !contestar CÓDIGO\n!campeoes · !historico\nADM: !painel · !forcarresultado CÓDIGO MxV motivo';
  else if(cmd==='!campeoes'||cmd==='!campeões'||cmd==='!historico'||cmd==='!histórico'){
   const saved=(await q.query('SELECT competition_name,champion_name,edition FROM mlg_bot.loan_champions WHERE group_id=$1 ORDER BY edition DESC LIMIT 15',[group])).rows;
   const current=(await q.query("SELECT c.name,p.display_name FROM mlg_bot.guest_competitions c JOIN mlg_bot.guest_players p ON p.cup_id=c.id AND p.user_id=c.champion_id WHERE c.group_id=$1 AND c.status='completed' ORDER BY c.created_at DESC LIMIT 5",[group])).rows;
   reply='🏆 CAMPEÕES DESTE GRUPO\n'+([...current.map(x=>x.name+' · '+x.display_name),...saved.map(x=>'Edição '+x.edition+' · '+x.competition_name+' · '+x.champion_name)].join('\n')||'Ainda não há campeão.');
  }else if(!cup)reply='Nenhum campeonato aberto. O organizador inicia com !novacopa e !painel.';
  else if(cmd==='!entrar'){
   if(cup.status!=='open')reply='Inscrições encerradas.';
   else if(players.some(p=>p.user_id===user))reply='Você já está inscrito.';
   else if(players.length>=cup.size)reply='As vagas já foram preenchidas.';
   else{
    const available=(await q.query('SELECT name FROM mlg_bot.club_pool WHERE group_id=$1',[group])).rows.map(x=>x.name).filter(t=>!players.some(p=>p.team===t));
    if(!available.length)reply='Não há times livres. O organizador deve revisar !equipes.';
    else{
     const team=available[randomInt(available.length)],display=(name??'Participante').slice(0,60);
     const position=players.length?Math.max(...players.map(p=>p.position))+1:0;
     await q.query('INSERT INTO mlg_bot.guest_players(cup_id,user_id,display_name,team,position) VALUES($1,$2,$3,$4,$5)',[cup.id,user,display,team,position]);
     players.push({cup_id:cup.id,user_id:user,display_name:display,team,position});people.set(user,display);
     reply='✅ '+display+' entrou com '+team+' · '+players.length+'/'+cup.size+' vagas.';
     if(players.length===cup.size){
      await q.query("UPDATE mlg_bot.guest_competitions SET status='playing' WHERE id=$1",[cup.id]);
      await schedule(q,cup,players);
      const opening=(await q.query('SELECT * FROM mlg_bot.guest_matches WHERE cup_id=$1 AND round=0 AND leg=1 ORDER BY position',[cup.id])).rows;
      reply='🎲 CONFRONTOS · '+cup.name+'\n👥 INSCRITOS\n'+players.map(p=>'• '+p.display_name+' · '+p.team).join('\n')+'\n\n⚔️ '+(cup.mode==='liga'?'PRIMEIRA RODADA':'PRIMEIRA FASE')+'\n'+opening.map(m=>card(m,people)).join('\n')+'\n\n'+(cup.legs===2?'Ida e volta':'Jogo único')+' · !meujogo mostra o código; !resultado CÓDIGO MxV registra placar, mandante primeiro. Consulte !copa para todos os jogos.';
     }
    }
   }
  }else if(cmd==='!sair'){
   if(cup.status!=='open')reply='Após o sorteio, peça ao organizador para resolver a desistência.';
   else if(!players.some(p=>p.user_id===user))reply='Você não está inscrito.';
   else{await q.query('DELETE FROM mlg_bot.guest_players WHERE cup_id=$1 AND user_id=$2',[cup.id,user]);reply='✅ Sua vaga foi liberada.';}
  }else if(['!copa','!tabela','!classificacao','!classificação','!proximafase','!meujogo'].includes(cmd)){
   if(cup.status==='open')reply='🏆 '+cup.name+' · '+players.length+'/'+cup.size+' inscritos. Envie !entrar.';
   else if(cmd==='!tabela'||cmd==='!classificacao'||cmd==='!classificação')reply=cup.mode==='liga'?'📊 CLASSIFICAÇÃO · '+cup.name+'\n'+standingsText(guestStandings(players,matches.filter(m=>m.leg!==3))):'Esta Copa usa mata-mata. Veja !copa.';
   else{
    let pending=matches.filter(m=>m.status!=='confirmed');
    if(cmd==='!meujogo')pending=pending.filter(m=>m.home===user||m.away===user).slice(0,2);
    if(cmd==='!proximafase'&&pending.length)pending=pending.filter(m=>m.round===Math.min(...pending.map(x=>x.round)));
    reply='⚔️ '+cup.name+' · '+(cup.mode==='liga'?'pontos corridos':'mata-mata')+' · '+(cup.legs===2?'ida e volta':'jogo único')+'\n'+(pending.slice(0,24).map(m=>card(m,people)).join('\n')||'Nenhum jogo pendente.')+(pending.length>24?'\n…mais '+(pending.length-24)+' jogos; use !meujogo.':'')+'\nPlacar: !resultado CÓDIGO MxV (mandante primeiro).';
   }
  }else if(cmd==='!resultado'||cmd==='!confirmar'||cmd==='!cancelar'||cmd==='!contestar'||cmd==='!forcarresultado'){
   const forced=cmd==='!forcarresultado',scoreArg=args[1],goals=safeScore(scoreArg??'');
   if(!Number.isSafeInteger(n)||!selected)reply='Partida não encontrada. Veja os códigos em !copa ou !meujogo.';
   else if(cmd==='!resultado'||cmd==='!confirmar'||forced){
    if(!goals)reply='Use '+cmd+' CÓDIGO MxV. M e V são gols do mandante e visitante, nessa ordem.';
    else if(forced&&!admin)reply='Só o organizador ou um ADM geral pode corrigir um placar.';
    else if(forced&&args.slice(2).join(' ').length<8)reply='Informe um motivo de pelo menos oito caracteres após o placar.';
    else if(!forced&&selected.home!==user&&selected.away!==user)reply='Só os jogadores desta partida podem registrar ou confirmar o placar.';
    else if(selected.leg===3&&goals[0]===goals[1])reply='O desempate precisa de vencedor. Informe gols diferentes.';
    else if(cmd==='!resultado'){
     if(selected.status!=='scheduled')reply='Este jogo já possui placar. Use !jogo ou procure o organizador.';
     else{
      await q.query("UPDATE mlg_bot.guest_matches SET status='pending',home_score=$2,away_score=$3,author=$4,reported_at=$5 WHERE code=$1",[n,...goals,user,Date.now()]);
      await audit(q,cup,selected,user,'report',null,goals.join('x'));
      reply='📝 Placar recebido · '+people.get(selected.home)+' '+goals[0]+'x'+goals[1]+' '+people.get(selected.away)+'\nAdversário: !confirmar '+n+' '+goals.join('x')+' ou !contestar '+n+'. Autor: !cancelar '+n+'. Sem contestação, confirma em cinco minutos.';
     }
    }else if(cmd==='!confirmar'){
     if(selected.status!=='pending')reply='Não há placar aguardando confirmação neste jogo.';
     else if(selected.author===user)reply='A outra pessoa confirma; você pode !cancelar '+n+' antes da confirmação. Sem contestação, o bot confirma em cinco minutos.';
     else if(selected.home_score!==goals[0]||selected.away_score!==goals[1])reply='O placar informado é diferente. Confira o print e use !contestar '+n+'.';
     else{await q.query("UPDATE mlg_bot.guest_matches SET status='confirmed',confirmed_by=$2 WHERE code=$1",[n,user]);await audit(q,cup,selected,user,'confirm',score(selected),score(selected));reply='✅ Partida #'+n+' confirmada. '+await progress(q,cup,players,group);}
    }else{
     const downstream=matches.filter(m=>cup.mode==='copa'?m.round>selected.round||m.round===selected.round&&m.position===selected.position&&m.leg===3&&selected.leg!==3:m.leg===3&&selected.leg!==3);
     if(cup.status==='completed'&&Date.now()-cup.completed_at>600000)reply='Edição já arquivada; o campeão está preservado no histórico.';
     else if(downstream.some(m=>m.status!=='scheduled'))reply='Há placar na fase seguinte ou desempate. Não alterei o resultado; peça uma revisão dos jogos dependentes.';
     else{
      if(downstream.length){await q.query('DELETE FROM mlg_bot.guest_matches WHERE code=ANY($1::bigint[])',[downstream.map(m=>m.code)]);}
      if(cup.status==='completed')await q.query("UPDATE mlg_bot.guest_competitions SET status='playing',champion_id=NULL,completed_at=NULL WHERE id=$1",[cup.id]);
      const before=selected.home_score===null?null:score(selected);
      await q.query("UPDATE mlg_bot.guest_matches SET status='confirmed',home_score=$2,away_score=$3,author=$4,reported_at=$5,confirmed_by=$4 WHERE code=$1",[n,...goals,user,Date.now()]);
      await audit(q,cup,selected,user,'force',before,goals.join('x'),args.slice(2).join(' '));
      await q.query("INSERT INTO mlg_bot.control_audit(action,group_id,user_id) VALUES('guest-force-result',$1,$2)",[group,user]);
      reply='✅ ADM registrou #'+n+' · '+goals.join('x')+'. Motivo: '+args.slice(2).join(' ')+'\n'+await progress(q,cup,players,group);
     }
    }
   }else if(cmd==='!cancelar'){
    if(selected.status!=='pending'||selected.author!==user)reply='Só quem enviou um placar pendente pode cancelá-lo.';
    else{await q.query("UPDATE mlg_bot.guest_matches SET status='scheduled',home_score=NULL,away_score=NULL,author=NULL,reported_at=NULL WHERE code=$1",[n]);await audit(q,cup,selected,user,'cancel',score(selected),null);reply='✅ Placar pendente cancelado. Corrija com !resultado '+n+' MxV.';}
   }else{
    if(selected.status!=='pending'||selected.author===user||selected.home!==user&&selected.away!==user)reply='Só o adversário pode contestar um placar pendente.';
    else{await q.query("UPDATE mlg_bot.guest_matches SET status='disputed' WHERE code=$1",[n]);await audit(q,cup,selected,user,'dispute',score(selected),score(selected));reply='⚖️ Jogo #'+n+' contestado. O organizador deve verificar o print e usar !forcarresultado '+n+' MxV motivo.';}
   }
  }
  await notify(q,group,user,messageId,reply);
  return {accepted:true};
 });
}

export async function guestAutoConfirm(db){
 return db.transaction(async q=>{
  const row=(await q.query(`SELECT g.group_id,g.id AS cup_id,m.code FROM mlg_bot.guest_matches m
   JOIN mlg_bot.guest_competitions g ON g.id=m.cup_id JOIN mlg_bot.loan_groups l ON l.group_id=g.group_id AND l.active
   WHERE m.status='pending' AND m.reported_at<$1 ORDER BY m.reported_at LIMIT 1`,[Date.now()-300000])).rows[0];
  if(!row)return {confirmed:false};
  await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[row.group_id]);
  const match=(await q.query('SELECT * FROM mlg_bot.guest_matches WHERE code=$1 FOR UPDATE',[row.code])).rows[0];
  if(match.status!=='pending'||match.reported_at>Date.now()-300000)return {confirmed:false};
  const cup=(await q.query('SELECT * FROM mlg_bot.guest_competitions WHERE id=$1',[row.cup_id])).rows[0];
  const players=(await q.query('SELECT * FROM mlg_bot.guest_players WHERE cup_id=$1 ORDER BY position',[row.cup_id])).rows;
  await q.query("UPDATE mlg_bot.guest_matches SET status='confirmed',confirmed_by=author WHERE code=$1",[row.code]);
  await audit(q,cup,match,match.author,'auto-confirm',score(match),score(match));
  const follow=await progress(q,cup,players,row.group_id);
  const user=match.author;const id='auto-'+randomUUID();
  await q.query('INSERT INTO mlg_bot.processed_messages(group_id,user_id,message_id,received_at) VALUES($1,$2,$3,$4)',[row.group_id,user,id,Date.now()]);
  await notify(q,row.group_id,user,id,'✅ Jogo #'+row.code+' confirmado automaticamente após cinco minutos sem contestação. '+follow);
  return {confirmed:true};
 });
}

export async function guestArchive(db){
 return db.transaction(async q=>{
  const row=(await q.query(`SELECT c.* FROM mlg_bot.guest_competitions c JOIN mlg_bot.loan_groups l ON l.group_id=c.group_id
   WHERE c.status IN ('completed','cancelled') AND (c.status='cancelled' OR c.completed_at<$1)
   ORDER BY c.created_at LIMIT 1`,[Date.now()-600000])).rows[0];
  if(!row)return {archived:false};
  await q.query('SELECT id FROM mlg_bot.groups WHERE id=$1 FOR UPDATE',[row.group_id]);
  if((await q.query("SELECT 1 FROM mlg_bot.outbox WHERE group_id=$1 AND status<>'sent' LIMIT 1",[row.group_id])).rows.length)return {archived:false};
  if(row.status==='completed'){
   const winner=(await q.query('SELECT display_name FROM mlg_bot.guest_players WHERE cup_id=$1 AND user_id=$2',[row.id,row.champion_id])).rows[0];
   const edition=Number((await q.query('SELECT count(*)::int AS n FROM mlg_bot.loan_champions WHERE group_id=$1',[row.group_id])).rows[0].n)+1;
   await q.query('INSERT INTO mlg_bot.loan_champions(cup_id,group_id,champion_id,champion_name,competition_name,edition,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.group_id,row.champion_id,winner.display_name,row.name,edition,row.completed_at]);
  }
  await q.query('DELETE FROM mlg_bot.guest_result_audit WHERE cup_id=$1',[row.id]);
  await q.query('DELETE FROM mlg_bot.guest_matches WHERE cup_id=$1',[row.id]);
  await q.query('DELETE FROM mlg_bot.guest_players WHERE cup_id=$1',[row.id]);
  await q.query('DELETE FROM mlg_bot.guest_competitions WHERE id=$1',[row.id]);
  await q.query("DELETE FROM mlg_bot.outbox WHERE group_id=$1 AND status='sent' AND sent_at<now()-interval '7 days'",[row.group_id]);
  await q.query(`DELETE FROM mlg_bot.processed_messages p WHERE p.group_id=$1 AND p.received_at<$2
   AND NOT EXISTS(SELECT 1 FROM mlg_bot.outbox o WHERE o.group_id=p.group_id AND o.user_id=p.user_id AND o.message_id=p.message_id)`,[row.group_id,Date.now()-604800000]);
  return {archived:true};
 });
}
