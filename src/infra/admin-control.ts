export type ControlDraft={name:string;teamKind:'clube'|'seleção'|'misto';teams:string[];size:number|null;reviewed?:string;reviewedAt?:number};
export type ControlWorkspace={targetId?:string;draft?:ControlDraft};
export type ControlTarget={id:string;name:string};
type Api=(body:Record<string,unknown>)=>Promise<any>;
const label=(kind:ControlDraft['teamKind'])=>kind==='seleção'?'seleções':kind==='misto'?'clubes e seleções':'clubes';
const clean=(value:string)=>value.trim().toLocaleLowerCase('pt-BR');
const safeTeam=(value:string)=>value.length>=2&&value.length<=60&&!/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(value);
const validTeams=(teams:string[])=>teams.length<=200&&teams.every(safeTeam)&&new Set(teams.map(clean)).size===teams.length;
const fingerprint=(d:ControlDraft)=>JSON.stringify([d.name,d.teamKind,d.teams,d.size]);
const menu='🎛️ CENTRAL MLG · ADMs\n!grupos — destinos disponíveis\n!usar número — escolher o grupo da Copa\n!novacopa — preparar a edição com o modelo ativo\n!nome Nome da Copa\n!categoria clubes | seleções | misto\n!equipes Time A | Time B | ... (substitui a lista)\n!adicionar Time A | Time B · !remover Nome exato\n!times — conferir o sorteio disponível\n!vagas 4 | 8 | 16 | 32\n!revisar — conferir tudo antes de abrir\n!abrircopa — salvar o modelo e abrir inscrições\n!descartar — abandonar apenas a preparação\n!cancelarcopa motivo · !anularcopa edição motivo\n\n🛡️ Cada ADM é identificado pela conta selecionada no painel. Jogos e placares seguem no grupo da Copa.';
function requireSuccess<T>(value:any):T {if(value?.error)throw Error(value.error);return value as T;}

export async function adminControl(text:string,room:ControlWorkspace,targets:ControlTarget[],api:Api,save:()=>Promise<void>,now=Date.now()):Promise<string>{
 const trimmed=text.trim();const [command='']=trimmed.split(/\s+/,1);const arg=trimmed.slice(command.length).trim();const cmd=command.toLocaleLowerCase('pt-BR');
 if(cmd==='!ajuda'||cmd==='!comandos'||cmd==='!painel')return menu;
 if(cmd==='!grupos')return '📍 GRUPOS DE COPA\n'+(targets.map((g,i)=>(room.targetId===g.id?'● ':'○ ')+(i+1)+'. '+g.name).join('\n')||'Nenhum grupo autorizado. Cadastre um no painel.')+'\n\nEnvie !usar número para escolher onde a Copa acontecerá.';
 if(cmd==='!usar'){
  const n=Number(arg);if(!Number.isSafeInteger(n)||n<1||n>targets.length)return 'Use !grupos e depois !usar número da lista.';
  const choice=targets[n-1]!;room.targetId=choice.id;delete room.draft;await save();return '✅ Destino: '+choice.name+'\nUse !novacopa para preparar a edição. Nenhuma inscrição foi aberta.';
 }
 const target=targets.find(g=>g.id===room.targetId);
 if(!target)return 'Escolha primeiro o destino: !grupos e !usar número. Apenas grupos de Copa autorizados aparecem.';
 const group=target.id;
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
