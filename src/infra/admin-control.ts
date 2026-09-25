export type ControlDraft={name:string;teamKind:'clube'|'seleção'|'misto';teams:string[];size:number|null;reviewed?:string;reviewedAt?:number};
export type ControlWorkspace={targetId?:string;draft?:ControlDraft;draw?:{group:string;cupId:string;fingerprint:string;mode:'equipes'|'chave'|'completo';reason:string;expiresAt:number};roster?:{group:string;fingerprint:string;change:'incluir'|'retirar'|'trocar';position?:number;targetAliases?:string[];targetName?:string;reason:string;expiresAt:number}};
export type ControlTarget={id:string;name:string};
type Api=(body:Record<string,unknown>)=>Promise<any>;
const label=(kind:ControlDraft['teamKind'])=>kind==='seleção'?'seleções':kind==='misto'?'clubes e seleções':'clubes';
const clean=(value:string)=>value.trim().toLocaleLowerCase('pt-BR');
const safeTeam=(value:string)=>value.length>=2&&value.length<=60&&!/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(value);
const validTeams=(teams:string[])=>teams.length<=200&&teams.every(safeTeam)&&new Set(teams.map(clean)).size===teams.length;
const fingerprint=(d:ControlDraft)=>JSON.stringify([d.name,d.teamKind,d.teams,d.size]);
const menu=`🎛️ CENTRAL MLG · GUIA DOS ADMs

⚡ LIGAR E MÓDULOS
!statusbot — ver o estado do bot
!acordarbot / !desligarbot — liberar ou pausar respostas
!reiniciarbot — reinício controlado
!copas ligar / desligar — ativar ou pausar as Copas
!resenha ligar / desligar — ativar ou pausar a resenha

📍 ESCOLHER A COPA
!grupos — listar destinos disponíveis
!usar 1 — selecionar o grupo da lista
!central — consultar a edição e o preparo salvo
!pendencias — conferir decisões pendentes
!modelos — listar modelos de campeonato
!ativarmodelo 1 — selecionar modelo entre edições

🏆 PREPARAR NOVA EDIÇÃO
!novacopa — iniciar a configuração
!nome / !categoria — definir identidade e tipo
!equipes — ver a lista; !adicionar / !remover — editá-la
!times / !vagas — conferir e escolher as vagas
!revisar — conferir; !abrircopa — publicar
!descartar — cancelar o preparo

👥 ELENCO DA COPA SELECIONADA
!inscritosadm — ver participantes e posições
!inscrever telefone Nome | motivo — preencher vaga
!retirar posição | motivo — remover antes do sorteio
!trocar posição telefone Nome | motivo — substituir sem placar
!confirmarelenco / !cancelarelenco — decidir mudança

🎲 SORTEIO E CHAVE
!sorteio — ver equipes e confrontos
No grupo da Copa: !copa (tudo), !chave A ou !chave B
!refazersorteio equipes motivo — redistribuir equipes
!refazersorteio chave motivo — refazer confrontos
!refazersorteio completo motivo — refazer ambos
!confirmarsorteio / !cancelarsorteio — decidir correção
Correções do sorteio exigem ausência de placares.

🛡️ ENCERRAR E CORRIGIR
!cancelarcopa motivo — cancelar edição atual
!anularcopa edição motivo — anular edição encerrada
No grupo da Copa: !vistoria e !resolver código 4x3 motivo.

📌 Use !painel para consultar este guia. Mudanças ficam registradas.`;
function requireSuccess<T>(value:any):T {if(value?.error)throw Error(value.error);return value as T;}

export async function adminControl(text:string,room:ControlWorkspace,targets:ControlTarget[],api:Api,save:()=>Promise<void>,now=Date.now(),actor?:{controlGroup:string;aliases:string[];resolveMember?:(group:string,phone:string)=>Promise<string[]|null>}):Promise<string>{
 const trimmed=text.trim();const [command='']=trimmed.split(/\s+/,1);const arg=trimmed.slice(command.length).trim();const cmd=command.toLocaleLowerCase('pt-BR');
 if(cmd==='!ajuda'||cmd==='!comandos'||cmd==='!painel')return menu;
 if(cmd==='!grupos')return '📍 GRUPOS DE COPA\n'+(targets.map((g,i)=>(room.targetId===g.id?'● ':'○ ')+(i+1)+'. '+g.name).join('\n')||'Nenhum grupo autorizado. Cadastre um no painel.')+'\n\nEnvie !usar número para escolher onde a Copa acontecerá.';
 if(cmd==='!usar'){
  const n=Number(arg);if(!Number.isSafeInteger(n)||n<1||n>targets.length)return 'Use !grupos e depois !usar número da lista.';
  const choice=targets[n-1]!;room.targetId=choice.id;delete room.draft;delete room.draw;delete room.roster;await save();return '✅ Destino: '+choice.name+'\nUse !novacopa para preparar a edição. Nenhuma inscrição foi aberta.';
 }
 const target=targets.find(g=>g.id===room.targetId);
 if(!target)return 'Escolha primeiro o destino: !grupos e !usar número. Apenas grupos de Copa autorizados aparecem.';
 const group=target.id;
 if(cmd==='!cancelarelenco'){delete room.roster;await save();return '🗑️ Mudança de participantes descartada. A Copa permanece como estava.';}
 if(['!inscritosadm','!inscrever','!retirar','!trocar','!confirmarelenco'].includes(cmd)){
  if(!actor)return 'Não foi possível validar o ADM desta central.';
  const request={action:'cup-roster',group,controlGroup:actor.controlGroup,aliases:actor.aliases};
  if(cmd==='!confirmarelenco'){
   const pending=room.roster;if(!pending||pending.group!==group||pending.expiresAt<now)return 'Não há mudança aguardando confirmação. Use !inscritosadm e prepare novamente.';
   const result=await api({...request,...pending,expected:pending.fingerprint});
   if(result.error){delete room.roster;await save();return '⚠️ '+result.error;}
   delete room.roster;await save();return '✅ Participantes atualizados em '+target.name+'. O grupo receberá o aviso; o estado anterior ficou guardado no banco.';
  }
  const current=await api(request);if(current.error)return '⚠️ '+current.error;
  if(cmd==='!inscritosadm')return '👥 PARTICIPANTES · '+current.name+'\n'+current.participants.map((p:any,i:number)=>`${i+1}. ${p.display_name}${p.club?' · '+p.club:''}`).join('\n')+'\n\n'+current.participants.length+'/'+current.size+' inscritos · '+(current.status==='open'?'inscrições abertas':'sorteio realizado')+'\n\n!inscrever telefone Nome | motivo\n!retirar posição | motivo\n!trocar posição telefone Nome | motivo';
  const segments=arg.split('|');const reason=segments.length===2?segments[1]!.trim():'';
  if(reason.length<8||reason.length>160||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(reason))return 'Informe um motivo de 8 a 160 caracteres após |. Exemplo: !retirar 2 | desistiu antes do sorteio';
  let position:number|undefined,targetName:string|undefined,targetAliases:string[]|undefined;
  if(cmd==='!retirar'){
   position=Number(segments[0]);if(!Number.isSafeInteger(position)||position<1||position>current.participants.length)return 'Posição inválida. Consulte !inscritosadm.';
  }else{
   const match=cmd==='!trocar'?segments[0]!.trim().match(/^(\d+)\s+(\d{10,15})\s+(.{2,60})$/):segments[0]!.trim().match(/^(\d{10,15})\s+(.{2,60})$/);
   if(!match)return cmd==='!trocar'?'Use !trocar posição telefone Nome completo | motivo.':'Use !inscrever telefone Nome completo | motivo.';
   if(cmd==='!trocar'){position=Number(match[1]);targetName=match[3]!.trim();}else targetName=match[2]!.trim();
   const phone=cmd==='!trocar'?match[2]!:match[1]!;
   if(position!==undefined&&(!Number.isSafeInteger(position)||position<1||position>current.participants.length))return 'Posição inválida. Consulte !inscritosadm.';
   if(!targetName||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(targetName))return 'Informe o nome do novo jogador sem caracteres especiais.';
   targetAliases=await actor.resolveMember?.(group,phone)??undefined;
   if(!targetAliases)return 'Esta conta não foi localizada no grupo da Copa pelo número completo. Adicione a pessoa ao grupo e confira o DDI e DDD.';
  }
  if(current.status==='playing'&&cmd!=='!trocar')return 'Após o sorteio, apenas a substituição é possível antes do primeiro placar. Use !resolver se já houve jogo.';
  if(cmd==='!inscrever'&&current.participants.length>=current.size)return 'A Copa já está cheia. Use !trocar antes do primeiro placar, se necessário.';
  room.roster={group,fingerprint:current.fingerprint,change:cmd==='!inscrever'?'incluir':cmd==='!retirar'?'retirar':'trocar',position,targetAliases,targetName,reason,expiresAt:now+300_000};await save();
  const previous=position?current.participants[position-1].display_name:'';
  return '🔎 CONFERIR PARTICIPANTES\n📍 '+target.name+' · '+current.name+'\n'+(cmd==='!inscrever'?'Incluir '+targetName:cmd==='!retirar'?'Retirar '+previous:'Trocar '+previous+' por '+targetName)+(current.status==='playing'?' · seleção e código do jogo preservados':'')+'\nMotivo: '+reason+'\n\nEnvie !confirmarelenco em até 5 minutos ou !cancelarelenco para desistir. Se a lista mudar, a confirmação será bloqueada.';
 }
 if(cmd==='!pendencias'){
  const current=requireSuccess<any>(await api({action:'templates-list',group}));const cup=current.activeCup;
  return `📋 VISTORIA · ${target.name}\n${cup?'🏆 '+cup.name+' · '+cup.participants+'/'+cup.size+' participantes\n⏳ Placares pendentes: '+cup.pending+' · ⚖️ Contestações: '+cup.disputed:'Nenhuma Copa aberta neste grupo.'}\n🛡️ Registros de recuperação: ${cup?.checkpointCount??0}\n\nPara ver os jogos, envie !copa no grupo do campeonato.`;
 }
 if(cmd==='!modelos'||cmd==='!ativarmodelo'){
  const current=requireSuccess<any>(await api({action:'templates-list',group}));
  const templates=current.templates??[];
  if(cmd==='!modelos')return '🏆 MODELOS · '+target.name+'\n'+(templates.map((m:any,i:number)=>`${i+1}. ${m.name} · ${m.teamCount} times${m.id===current.activeTemplateId?' · ATIVO':''}`).join('\n')||'Nenhum modelo salvo. Prepare uma Copa com !novacopa ou crie um no painel.')+'\n\nPara escolher entre Copas: !ativarmodelo número.';
  const n=Number(arg);if(!Number.isSafeInteger(n)||n<1||n>templates.length)return 'Use !modelos e depois !ativarmodelo número da lista.';
  const selected=templates[n-1];if(current.activeCup)return 'A Copa em andamento termina antes de trocar o modelo. O sorteio atual está preservado.';
  const result=await api({action:'template-activate',group,templateId:selected.id});
  return result.error?'⚠️ '+result.error:'✅ Modelo ativo: '+selected.name+'. A próxima Copa usará estes times. Copas anteriores não mudaram.';
 }
 if(cmd==='!cancelarsorteio'){delete room.draw;await save();return '🗑️ Correção de sorteio descartada. A Copa continua como estava.';}
 if(['!sorteio','!refazersorteio','!confirmarsorteio'].includes(cmd)){
  if(!actor)return 'Não foi possível validar o ADM desta central.';
  const request={action:'cup-draw',group,controlGroup:actor.controlGroup,aliases:actor.aliases};
  if(cmd==='!confirmarsorteio'){
   const pending=room.draw;
   if(!pending||pending.group!==group||pending.expiresAt<now)return 'Não há sorteio aguardando confirmação. Envie !refazersorteio equipes, chave ou completo, seguido do motivo.';
   const changed=await api({...request,mode:pending.mode,expected:pending.fingerprint,reason:pending.reason});
   if(changed.error){delete room.draw;await save();return '⚠️ '+changed.error;}
   delete room.draw;await save();return '✅ Sorteio atualizado em '+target.name+'. As novas equipes e partidas serão anunciadas no grupo da Copa. O estado anterior foi guardado para recuperação.';
  }
  const current=await api(request);
  if(current.error)return '⚠️ '+current.error;
  if(cmd==='!sorteio')return '🎲 SORTEIO ATUAL · '+current.name+'\n📍 '+target.name+'\n\n⚽ EQUIPES\n'+current.participants.map((p:any,i:number)=>`${i+1}. ${p.display_name} → ${p.club}`).join('\n')+'\n\n⚔️ CONFRONTOS\n'+current.matches.map((m:any)=>'Jogo '+m.code+': '+current.participants.find((p:any)=>p.user_id===m.home)?.display_name+' × '+current.participants.find((p:any)=>p.user_id===m.away)?.display_name).join('\n')+'\n\nPara corrigir, use !refazersorteio equipes, chave ou completo, seguido do motivo.';
  const match=arg.match(/^(equipes|chave|completo)\s+(.{8,160})$/s);
  if(!match||match[2]!.trim().length<8||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(match[2]!))return 'Use !refazersorteio equipes | chave | completo seguido de um motivo de 8 a 160 caracteres.';
  const mode=match[1] as 'equipes'|'chave'|'completo';room.draw={group,cupId:current.cupId,fingerprint:current.fingerprint,mode,reason:match[2]!.trim(),expiresAt:now+300_000};await save();
  return '🔎 CONFIRMAR NOVO SORTEIO\n📍 '+target.name+' · '+current.name+'\n🎲 Mudança: '+(mode==='equipes'?'redistribuir as equipes atuais':mode==='chave'?'refazer os confrontos':'redistribuir equipes e refazer confrontos')+'\n📋 Motivo: '+room.draw.reason+'\n\nAs partidas ainda não têm resultado. Envie !confirmarsorteio em até 5 minutos. Se alguém registrar resultado ou alterar a chave, a confirmação será bloqueada. Para voltar: !cancelarsorteio.';
 }
 if(cmd==='!central'){
  const current=requireSuccess<any>(await api({action:'templates-list',group}));
  return '🎛️ CENTRAL MLG\n📍 '+target.name+'\n🏆 Modelo ativo: '+current.activeCompetition+'\n'+(current.activeCup?'🎮 Copa em andamento: '+current.activeCup.participants+'/'+current.activeCup.size+' inscritos.':current.preparing?'⏳ Um ADM está escolhendo o formato no grupo da Copa.':'📣 Nenhuma Copa aberta.')+'\n'+(room.draft?'📝 Preparação salva: '+room.draft.name+(room.draft.size?' · '+room.draft.size+' vagas':' · vagas a definir'):'📝 Sem preparação em andamento.')+'\n\n!painel mostra os comandos.';
 }
 if(cmd==='!novacopa'){
  const [config,list]=await Promise.all([api({action:'competition-get',group}),api({action:'templates-list',group})]);
  requireSuccess(config);requireSuccess(list);
  if(list.activeCup)return '⚠️ Já há uma Copa aberta em '+target.name+'. Consulte !central ou cancele com um motivo.';
  if(list.preparing)return '⏳ Um ADM já iniciou !novacopa no grupo dos jogadores. Termine ou cancele aquela preparação antes de começar outra.';
  if(room.draft)return '📝 Já existe uma preparação salva: '+room.draft.name+'. Use !revisar para continuar ou !descartar para começar outra.';
  room.draft={name:config.competition.name,teamKind:config.competition.teamKind,teams:config.competition.teams,size:null};await save();
  return '🏆 PREPARAÇÃO INICIADA\n📍 '+target.name+'\n'+room.draft.name+' · '+room.draft.teams.length+' '+label(room.draft.teamKind)+'\n\nAjuste com !nome, !categoria, !equipes ou !adicionar. Depois !vagas 4/8/16/32 e !revisar. Nenhuma inscrição foi aberta.';
 }
 if(cmd==='!cancelarcopa'){
  if(arg.length<8)return 'Informe um motivo: !cancelarcopa motivo com ao menos 8 caracteres.';
  const result=requireSuccess<any>(await api({action:'cup-cancel',group,reason:arg}));
  return result.draft?'🚫 Escolha de formato iniciada no grupo da Copa cancelada. Nenhuma partida foi apagada.':result.cancelled?'🚫 Copa cancelada em '+target.name+'. Histórico e registros de recuperação preservados; o aviso será enviado ao grupo.':'⚠️ Não foi possível cancelar a Copa.';
 }
 if(cmd==='!anularcopa'){
  const match=arg.match(/^(\d+)\s+(.{8,160})$/s);if(!match)return 'Formato: !anularcopa número-da-edição motivo (mínimo 8 caracteres).';
  const edition=Number(match[1]);if(!Number.isSafeInteger(edition)||edition<1)return 'Número de edição inválido. Veja as edições com !historico no grupo da Copa.';
  const result=requireSuccess<any>(await api({action:'cup-void',group,edition,reason:match[2]!.trim()}));
  return result.cancelled?'📋 Edição '+edition+' anulada em '+target.name+'. O histórico permanece; a edição sai das estatísticas.':'⚠️ Edição não encontrada ou não encerrada.';
 }
 if(cmd==='!descartar'){if(!room.draft)return 'Não há preparação para descartar.';delete room.draft;await save();return '🗑️ Preparação descartada. Nenhuma Copa ou modelo salvo foi apagado.';}
 const draft=room.draft;
 if(!draft)return 'Não há preparação. Envie !novacopa para começar no grupo '+target.name+'.';
 if(cmd==='!nome'){
  if(arg.length<3||arg.length>60||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(arg))return 'Use !nome Nome da Copa (3 a 60 caracteres).';
  draft.name=arg;delete draft.reviewed;await save();return '✅ Nome: '+arg+'\nUse !revisar antes de abrir.';
 }
 if(cmd==='!categoria'){
  const normalized=arg.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const kind=normalized==='selecao'||normalized==='selecoes'?'seleção':/^clubes?$/.test(normalized)?'clube':normalized==='misto'?'misto':null;
  if(!kind)return 'Use !categoria clubes, !categoria seleções ou !categoria misto.';
  draft.teamKind=kind;delete draft.reviewed;await save();return '✅ Categoria: '+label(kind)+'. Confira se os times da lista combinam com a categoria.';
 }
 if(cmd==='!equipes'||cmd==='!adicionar'){
  const entries=arg.split(/\||\n/).map(x=>x.trim()).filter(Boolean);
  const teams=cmd==='!equipes'?entries:[...draft.teams,...entries];
  if(entries.length===0||cmd==='!equipes'&&entries.length<4||!validTeams(teams))return 'Liste de 4 a 200 times diferentes, com nomes de 2 a 60 caracteres, separados por | ou por linha.';
  draft.teams=teams;if(draft.size&&teams.length<draft.size)draft.size=null;delete draft.reviewed;await save();return '✅ Lista salva: '+teams.length+' times. Use !times para conferir e !revisar antes de abrir.';
 }
 if(cmd==='!remover'){
  const i=draft.teams.findIndex(t=>clean(t)===clean(arg));if(i<0)return 'Time não encontrado. Use !times e informe o nome exato.';
  draft.teams.splice(i,1);if(draft.size&&draft.teams.length<draft.size)draft.size=null;delete draft.reviewed;await save();return '✅ '+arg+' removido da preparação. Restam '+draft.teams.length+' times.';
 }
 if(cmd==='!times'){
  const page=Number(arg||1),pages=Math.ceil(draft.teams.length/20);
  if(!Number.isSafeInteger(page)||page<1||page>pages)return 'Página inválida. Use !times 1 até !times '+pages+'.';
  return '🎲 TIMES NA PREPARAÇÃO · '+draft.teams.length+' · página '+page+'/'+pages+'\n'+draft.teams.slice((page-1)*20,page*20).map((name,i)=>((page-1)*20+i+1)+'. '+name).join('\n')+(page<pages?'\n\nPróxima: !times '+(page+1):'');
 }
 if(cmd==='!vagas'){
  const size=Number(arg);if(![4,8,16,32].includes(size)||size>draft.teams.length)return 'Escolha !vagas 4, 8, 16 ou 32. A lista precisa ter pelo menos tantos times quanto vagas.';
  draft.size=size;delete draft.reviewed;await save();return '✅ '+size+' vagas definidas. Use !revisar para confirmar o destino e a lista.';
 }
 if(cmd==='!revisar'){
  if(draft.teams.length<4||!validTeams(draft.teams)||!draft.size||draft.size>draft.teams.length)return '⚠️ Revise a lista (mínimo 4 times diferentes) e escolha !vagas 4, 8, 16 ou 32.';
  draft.reviewed=fingerprint(draft);draft.reviewedAt=now;await save();
  return '🔎 CONFERÊNCIA ANTES DE ABRIR\n📍 Grupo: '+target.name+'\n🏆 Nome: '+draft.name+'\n🎲 Categoria: '+label(draft.teamKind)+'\n👥 Vagas: '+draft.size+'\n⚽ Times ('+draft.teams.length+'): '+draft.teams.slice(0,20).join(' · ')+(draft.teams.length>20?'\nVeja os demais com !times 2.':'')+'\n\nSe estiver correto, envie !abrircopa em até 10 minutos. Qualquer alteração exige nova revisão. Os jogadores entram no grupo da Copa.';
 }
 if(cmd==='!abrircopa'){
  if(!draft.size||draft.reviewed!==fingerprint(draft)||!draft.reviewedAt||now-draft.reviewedAt>600_000)return 'Antes de abrir, defina !vagas e envie !revisar. A revisão vale 10 minutos e expira ao editar.';
  const current=requireSuccess<any>(await api({action:'templates-list',group}));if(current.activeCup||current.preparing)return '⚠️ Este grupo já tem Copa ativa ou formato em preparação. Nenhuma outra foi aberta.';
  const original=requireSuccess<any>(await api({action:'competition-get',group})).competition;
  const changed=original.name!==draft.name||original.teamKind!==draft.teamKind||JSON.stringify(original.teams)!==JSON.stringify(draft.teams);
  const proposal=changed?{name:draft.name,teamKind:draft.teamKind,teams:draft.teams}:undefined;
  const opened=requireSuccess<any>(await api({action:'cup-open',group,size:draft.size,...(proposal?{proposal}:{})}));
  if(!opened.opened)return '⚠️ O banco não confirmou a abertura. Consulte !central.';
  delete room.draft;await save();return '🏆 '+draft.name+' aberta em '+target.name+' com '+draft.size+' vagas! O bot anunciará as inscrições no grupo da Copa. Lá os jogadores usam !entrar.';
 }
 return 'Comando da central não reconhecido. Use !painel para ver os comandos deste grupo.';
}
