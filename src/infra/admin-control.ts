import {loanCommand,loanGuide,loanPhone} from './loan-invitation.ts';
export type ControlDraft={name:string;teamKind:'clube'|'seleção'|'misto';teams:string[];size:number|null;teamsApproved?:boolean;reviewed?:string;reviewedAt?:number};
export type ControlWorkspace={targetId?:string;guestImage?:'group'|'text';draft?:ControlDraft;guestDraft?:{name:string;mode:'liga'|'copa';legs:1|2;size:number|null;teams:string[];reviewed?:string};staged?:{name:string;teamKind:ControlDraft['teamKind'];teams:string[];size:number};draw?:{group:string;cupId:string;fingerprint:string;mode:'equipes'|'chave'|'completo';reason:string;expiresAt:number};roster?:{group:string;fingerprint:string;change:'incluir'|'retirar'|'trocar';position?:number;targetAliases?:string[];targetName?:string;reason:string;expiresAt:number};seasonReset?:{code:string;fingerprint:string;actorAliases:string[];expiresAt:number}};
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

🗓️ NOVA TEMPORADA
!reiniciar temporada — mostrar o resumo e preparar a limpeza
!confirmar temporada CÓDIGO — concluir em até 10 minutos
!cancelar temporada — descartar o pedido
Preserva jogadores, nomes, contas, ADMs e modelos. Apaga Copas, partidas e estatísticas da temporada anterior.

📍 ESCOLHER A COPA
!grupos — listar destinos disponíveis
!usar 1 — selecionar o grupo da lista
!central — consultar a edição e o preparo salvo
!pendencias — conferir decisões pendentes
!modelos — listar modelos de campeonato
!ativarmodelo 1 — selecionar modelo entre edições

🔐 PERMISSÕES POR CANAL
!adms — ver responsáveis pelo canal escolhido
!daradm telefone | geral — ADM de todos os canais autorizados
!daradm telefone | canal — ADM somente deste canal (ex.: Mini Camp)
!tiraradm telefone — retirar acesso neste canal

🤝 EMPRÉSTIMO POR GRUPO
!emprestar telefone — enviar convite e guia no privado
Depois adicione o bot ao grupo do convidado; ele abre !novacopa lá.
!emprestimo — consultar convites; !emprestimo telefone também convida
Repita !emprestar telefone se precisar reenviar o guia privado.
!devolverbot telefone — cancelar convite ainda sem grupo
Para devolver um grupo em uso: !usar número e !devolverbot.

🏆 PREPARAR NOVA EDIÇÃO
!novacopa — iniciar a configuração
!nome / !categoria — definir identidade e tipo
!equipes Time A | Time B | ... — enviar todos os times em massa
!confirmartimes — manter os times do modelo; !adicionar / !remover — editar
!times / !vagas — conferir e escolher as vagas
!revisar — conferir; !concluir — guardar para publicar no canal
No canal escolhido: !novacopa — abrir inscrições da Copa preparada
!abrircopa — publicar imediatamente pela central
!descartar — cancelar o preparo

👥 ELENCO DA COPA SELECIONADA
!inscritosadm — ver participantes e posições
!inscrever telefone Nome | motivo — preencher vaga
!retirar posição | motivo — remover antes do sorteio
!trocar posição telefone Nome | motivo — substituir sem placar
!confirmarelenco / !cancelarelenco — decidir mudança

🚫 MODERAÇÃO
!bloquear telefone | motivo — impede comandos e novas inscrições
!desbloquear telefone | motivo — restaura o acesso
!bloqueados — lista contas bloqueadas
Membro em Copa ativa deve ser substituído antes do bloqueio.

🪪 NOMES NO GRUPO DA COPA
!cadastrar @pessoa — guardar o nome da conta marcada
!editar @pessoa | Nome novo — corrigir o nome
!meunome Nome novo — corrigir o próprio nome de ADM
!excluir @pessoa — retirar inscrição antes do sorteio
O histórico continua na conta, sem o @ no nome.

🎲 SORTEIO E CHAVE
!sorteio — ver equipes e confrontos
No grupo da Copa: !copa, !chave A/B e !sorteio Samuel ou !sorteio @pessoa [| motivo] para trocar só o time durante a disputa
!refazersorteio equipes motivo — redistribuir equipes
!refazersorteio chave motivo — refazer confrontos
!refazersorteio completo motivo — refazer ambos
!confirmarsorteio / !cancelarsorteio — decidir correção
Correções do sorteio exigem ausência de placares.

🛡️ ENCERRAR E CORRIGIR
!cancelarcopa motivo — cancelar e liberar o número da edição
!anularcopa edição motivo — anular edição encerrada; use o número do !historico
!vistoria • !resolver CÓDIGO MxV motivo • !forcarresultado CÓDIGO MxV motivo
M e V são os gols em números (mandante primeiro, visitante depois), sem espaços.
Use !grupos e !usar para escolher o destino ao escrever de outro canal.

📌 ADMs cadastrados podem usar esta central em qualquer grupo autorizado do bot. Use !grupos e !usar para escolher a Copa; mudanças ficam registradas.`;
function requireSuccess<T>(value:any):T {if(value?.error)throw Error(value.error);return value as T;}

async function guestControl(text:string,room:ControlWorkspace,group:string,api:Api,save:()=>Promise<void>):Promise<string>{
 const [command='']=text.trim().split(/\s+/,1),cmd=command.toLocaleLowerCase('pt-BR'),arg=text.trim().slice(command.length).trim();
 if(['!ajuda','!comandos','!painel'].includes(cmd))return '🤝 GUIA DO ORGANIZADOR\n!novacopa — iniciar o preparo\n!nome Nome do campeonato\n!modalidade liga (pontos corridos) ou !modalidade copa (mata-mata)\n!vagas N — liga: 2 a 16; copa: 4, 8, 16 ou 32 (fases automáticas)\n!jogos 1 (jogo único) ou !jogos 2 (ida e volta)\n!equipes Time A | Time B | ... — ou um time por linha, para sorteio\n!imagemgrupo — usar a foto do grupo nos anúncios; !imagemtexto — só texto\n!revisar · !abrircopa — abrir inscrições\n!central · !cancelarcopa motivo\nJogadores: !entrar, !meujogo, !copa, !tabela, !resultado CÓDIGO MxV, !confirmar CÓDIGO MxV. O mandante vem primeiro. ADM: !forcarresultado CÓDIGO MxV motivo. !campeoes mostra o histórico.';
 const only=new Set(['!novacopa','!nome','!modalidade','!vagas','!formato','!jogos','!equipes','!adicionar','!remover','!times','!revisar','!abrircopa','!concluir','!central','!pendencias','!cancelarcopa','!descartar','!imagemgrupo','!imagemtexto']);
 if(!only.has(cmd))return '🔒 Este comando é reservado aos ADMs gerais da MLG. Use !painel para administrar somente este grupo.';
 if(cmd==='!imagemgrupo'||cmd==='!imagemtexto'){
  room.guestImage=cmd==='!imagemgrupo'?'group':'text';await save();
  return room.guestImage==='group'?'🖼️ Os anúncios do campeonato usarão a foto atual deste grupo. Se ela não estiver disponível, envio só o texto.':'📝 Anúncios em texto, sem imagens da MLG.';
 }
 if(cmd==='!central'||cmd==='!pendencias'){
  const status=await api({action:'guest-status',group});if(status.error)return '⚠️ '+status.error;
  const cup=status.cup;return '🤝 CAMPEONATO DESTE GRUPO\n'+(cup?`${cup.name} · ${cup.mode==='liga'?'pontos corridos':'mata-mata'} · ${cup.legs===2?'ida e volta':'jogo único'} · ${cup.size} vagas · ${cup.status}`:'Nenhum campeonato aberto.')+(room.guestDraft?'\n📝 Preparação: '+room.guestDraft.name:'')+'\n!painel mostra o guia.';
 }
 if(cmd==='!cancelarcopa'){
  if(arg.length<8||arg.length>160)return 'Use !cancelarcopa motivo com 8 a 160 caracteres.';
  const r=await api({action:'guest-cancel',group,reason:arg});return r.error?'⚠️ '+r.error:'🚫 Campeonato cancelado. O grupo poderá abrir outra edição; o campeão de edições anteriores permanece em !campeoes.';
 }
 if(cmd==='!descartar'){delete room.guestDraft;await save();return '✅ Preparo descartado. Nenhum campeonato foi aberto.';}
 if(cmd==='!novacopa'){
  const status=await api({action:'guest-status',group});if(status.error)return '⚠️ '+status.error;
  if(status.cup)return 'Já há campeonato aberto: '+status.cup.name+'. Use !central.';
  if(room.guestDraft)return 'Preparação em andamento: '+room.guestDraft.name+'. Use !revisar ou !descartar.';
  room.guestDraft={name:'Campeonato convidado',mode:'copa',legs:1,size:null,teams:[]};await save();
  return '🏆 NOVO CAMPEONATO\n1. !nome Nome\n2. !modalidade liga ou !modalidade copa\n3. !vagas N (define as fases do mata-mata)\n4. !jogos 1 ou !jogos 2\n5. !equipes Time A | Time B | ... ou um time por linha\n6. !imagemgrupo se quiser usar a foto do grupo; por padrão, só texto\n7. !revisar e !abrircopa. Nada foi aberto ainda.';
 }
 const d=room.guestDraft;if(!d)return 'Comece com !novacopa neste grupo.';
 if(cmd==='!nome'){
  if(arg.length<3||arg.length>60||/[\r\n\x00-\x1f\x7f*_~`]/.test(arg))return 'Use !nome Nome do campeonato (3 a 60 caracteres).';d.name=arg;
 }else if(cmd==='!modalidade'){
  const mode=({'pontos corridos':'liga','mata-mata':'copa','mata mata':'copa'} as Record<string,string>)[arg.toLowerCase()]??arg.toLowerCase();
  if(!['liga','copa'].includes(mode))return 'Use !modalidade liga para pontos corridos ou !modalidade copa para mata-mata.';
  d.mode=mode as 'liga'|'copa';if(d.size&&(d.mode==='liga'?d.size>16||d.size<2:![4,8,16,32].includes(d.size)))d.size=null;
 }else if(cmd==='!vagas'||cmd==='!formato'){
  const size=Number(arg);if(!Number.isSafeInteger(size)||d.mode==='liga'&&(size<2||size>16)||d.mode==='copa'&&![4,8,16,32].includes(size))return d.mode==='liga'?'Escolha !vagas de 2 a 16 para pontos corridos.':'Escolha !vagas 4, 8, 16 ou 32 para mata-mata.';d.size=size;
 }else if(cmd==='!jogos'){
  const legs=({'ida':'1','jogo único':'1','jogo unico':'1','ida e volta':'2'} as Record<string,string>)[arg.toLowerCase()]??arg;
  if(legs!=='1'&&legs!=='2')return 'Use !jogos 1 para jogo único ou !jogos 2 para ida e volta.';d.legs=Number(legs) as 1|2;
 }else if(cmd==='!equipes'||cmd==='!adicionar'){
  const teams=(cmd==='!adicionar'?[...d.teams]:[]).concat(arg.split(/\||\n/).map(s=>s.trim()).filter(Boolean));
  if(teams.length<2||!validTeams(teams))return 'Envie pelo menos dois times diferentes, separados por |. Máximo de 200, com nomes de 2 a 60 caracteres.';d.teams=teams;
 }else if(cmd==='!remover'){
  const i=d.teams.findIndex(t=>clean(t)===clean(arg));if(i<0)return 'Time não encontrado. Confira com !times.';d.teams.splice(i,1);
 }else if(cmd==='!times')return '⚽ TIMES ('+d.teams.length+')\n'+(d.teams.map((s,i)=>`${i+1}. ${s}`).join('\n')||'Envie !equipes Time A | Time B | ...');
 else if(cmd==='!revisar'){
  if(!d.size||d.teams.length<d.size||!validTeams(d.teams))return 'Defina !vagas e envie pelo menos tantos times quanto vagas com !equipes.';
  d.reviewed=JSON.stringify([d.name,d.mode,d.legs,d.size,d.teams]);await save();
  return `🔎 CONFIRA\n🏆 ${d.name}\n📍 ${d.mode==='liga'?'Pontos corridos':'Mata-mata'} · ${d.legs===2?'ida e volta':'jogo único'}\n👥 ${d.size} vagas · ${d.teams.length} times\n⚽ ${d.teams.join(' · ')}\n\nEnvie !abrircopa para abrir as inscrições. Para mudar, envie o comando de configuração e !revisar novamente.`;
 }else if(cmd==='!abrircopa'||cmd==='!concluir'){
  if(!d.reviewed||d.reviewed!==JSON.stringify([d.name,d.mode,d.legs,d.size,d.teams]))return 'Revise a configuração com !revisar antes de abrir.';
  const opened=await api({action:'guest-open',group,name:d.name,mode:d.mode,legs:d.legs,size:d.size,teams:d.teams});
  if(opened.error)return '⚠️ '+opened.error;
  delete room.guestDraft;await save();
  return `🏆 ${d.name} · inscrições abertas para ${d.size} jogadores! Formato: ${d.mode==='liga'?'pontos corridos':'mata-mata'}, ${d.legs===2?'ida e volta':'jogo único'}. Jogadores: !entrar. Ao fechar as vagas, o bot cria os jogos com código.`;
 }
 delete d.reviewed;await save();return '✅ Atualizado. Use !revisar para conferir as escolhas antes de abrir.';
}

export async function adminControl(text:string,room:ControlWorkspace,targets:ControlTarget[],api:Api,save:()=>Promise<void>,now=Date.now(),actor?:{controlGroup:string;aliases:string[];messageId?:string;resolveMember?:(group:string,phone:string)=>Promise<string[]|null>;resolveGroupAdmin?:(group:string,phone:string)=>Promise<string[]|null>;sendInvitation?:(phone:string,guide:string)=>Promise<void>},workspaces?:Record<string,ControlWorkspace>,loanMode=false):Promise<string>{
 const trimmed=loanCommand(text.trim());const [command='']=trimmed.split(/\s+/,1);const arg=trimmed.slice(command.length).trim();const cmd=command.toLocaleLowerCase('pt-BR');
 if(loanMode)return guestControl(text,room,room.targetId!,api,save);
 if(cmd==='!ajuda'||cmd==='!comandos'||cmd==='!painel')return menu;
 if(cmd==='!reiniciartemporada'||cmd==='!reiniciar'&&arg==='temporada'){
  if(!actor?.aliases?.length||!actor.messageId)return 'Envie o comando como ADM verificado em um grupo autorizado.';
  const preview=await api({action:'season-preview',source:actor.controlGroup,aliases:actor.aliases});
  if(preview.error)return '⚠️ '+preview.error;
  if(preview.active)return '⚠️ Há Copa com inscrições ou jogos em andamento. Encerre ou cancele as edições antes de iniciar outra temporada.';
  const code=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
  room.seasonReset={code,fingerprint:preview.fingerprint,actorAliases:actor.aliases,expiresAt:now+600_000};await save();
  return `🗓️ REINÍCIO DA TEMPORADA ${preview.season}\nSerão apagadas ${preview.cups} Copas e ${preview.matches} partidas, com resultados, estatísticas e avisos pendentes.\nJogadores, nomes, contas vinculadas, ADMs e modelos continuarão salvos.\nPara iniciar a temporada ${preview.season+1}, envie !confirmar temporada ${code} em até 10 minutos.\nPara desistir: !cancelar temporada.`;
 }
 if(cmd==='!cancelartemporada'||cmd==='!cancelar'&&arg==='temporada'){
  delete room.seasonReset;await save();return '✅ Pedido de reinício descartado. Nenhuma Copa foi alterada.';
 }
 if(cmd==='!confirmartemporada'||cmd==='!confirmar'&&arg.startsWith('temporada ')){
  const code=cmd==='!confirmar'?arg.slice('temporada '.length).trim():arg;
  const pending=room.seasonReset;
  if(!actor?.aliases?.length||!actor.messageId)return 'Envie a confirmação como ADM verificado em um grupo autorizado.';
  if(!pending||pending.expiresAt<now||pending.code!==code.toUpperCase()||!actor.aliases.some(a=>pending.actorAliases.includes(a)))return '⚠️ Confirmação inválida ou vencida. Use !reiniciar temporada para receber um código novo.';
  const result=await api({action:'season-reset',source:actor.controlGroup,aliases:actor.aliases,messageId:actor.messageId,fingerprint:pending.fingerprint});
  if(result.error){delete room.seasonReset;await save();return '⚠️ '+result.error+' Use !reiniciar temporada para revisar novamente.';}
  delete room.seasonReset;delete room.draft;delete room.draw;delete room.roster;await save();
  return `✅ TEMPORADA REINICIADA · agora é a temporada ${result.season}.\nJogadores e nomes preservados. Configure e abra as novas Copas com !novacopa.`;
 }
 if(cmd==='!grupos')return '📍 GRUPOS DE COPA\n'+(targets.map((g,i)=>(room.targetId===g.id?'● ':'○ ')+(i+1)+'. '+g.name).join('\n')||'Nenhum grupo autorizado. Cadastre um no painel.')+'\n\nEnvie !usar número para escolher onde a Copa acontecerá.';
 if(['!emprestar','!emprestimo'].includes(cmd)||cmd==='!devolverbot'&&arg){
  if(!actor?.aliases.length)return 'Apenas ADMs gerais podem administrar convites.';
  const request={action:'loan-invite',source:actor.controlGroup,aliases:actor.aliases};
  if(cmd==='!emprestimo'&&!arg){
   const result=await api({...request,operation:'get'});
   return result.error?'⚠️ '+result.error:'🤝 EMPRÉSTIMOS\n'+(result.invitations?.map((x:{jid?:string;name:string;claimed_group?:string})=>`${x.jid?.split('@')[0]??x.name} · ${x.claimed_group?'grupo em uso':'aguardando grupo'}`).join('\n')||'Nenhum convite ativo.')+'\n\n!emprestar telefone · !devolverbot telefone para convite pendente.';
  }
  const phone=loanPhone(arg);
  if(!phone)return cmd!=='!devolverbot'?'Use !emprestar telefone com DDI e DDD.':'Use !devolverbot telefone para cancelar um convite ainda não usado.';
  const result=await api({...request,operation:cmd==='!devolverbot'?'revoke':'grant',targetAliases:[phone+'@s.whatsapp.net']});
  if(result.error)return '⚠️ '+result.error;
  if(cmd==='!devolverbot')return '✅ Convite cancelado. Nenhum grupo foi alterado.';
  const recorded=result.existing?'Empréstimo já registrado':'Convite registrado';
  try{
   if(!actor.sendInvitation)throw Error('Private sender unavailable');
   await actor.sendInvitation(phone,loanGuide);
   return '✅ '+recorded+' para '+phone+'. O guia foi enviado no privado. Adicione o bot ao grupo do convidado e peça que ele envie !novacopa lá.';
  }catch{return '✅ '+recorded+' para '+phone+', mas o WhatsApp não confirmou o envio do guia privado. Quando o bot estiver conectado, repita !emprestar '+phone+' para reenviar sem criar outro empréstimo.';}
 }
 if(cmd==='!usar'){
  const n=Number(arg);if(!Number.isSafeInteger(n)||n<1||n>targets.length)return 'Use !grupos e depois !usar número da lista.';
  const choice=targets[n-1]!;room.targetId=choice.id;delete room.draft;delete room.draw;delete room.roster;await save();return '✅ Destino: '+choice.name+'\nUse !novacopa para preparar a edição. Nenhuma inscrição foi aberta.';
 }
 const target=targets.find(g=>g.id===room.targetId);
 if(!target)return 'Escolha primeiro o destino: !grupos e !usar número. Apenas grupos de Copa autorizados aparecem.';
 const group=target.id;
 if(cmd==='!devolverbot'){
  if(!actor?.aliases.length)return 'Só um ADM geral verificado pode administrar empréstimos.';
  const request={action:'loan-manage',source:actor.controlGroup,group,aliases:actor.aliases};
  const result=await api({...request,operation:'revoke'});
  return result.error?'⚠️ '+result.error:'✅ Empréstimo encerrado em '+target.name+'. Campeões resumidos permanecem disponíveis.';
 }
 if(['!adms','!daradm','!tiraradm'].includes(cmd)){
  if(!actor?.aliases?.length)return 'Apenas um ADM geral verificado pode gerenciar acessos.';
  const request={action:'admin-access',source:actor.controlGroup,group,aliases:actor.aliases};
  if(cmd==='!adms'){
   const result=await api({...request,operation:'list'});
   if(result.error)return '⚠️ '+result.error;
   return '🔐 ADMs · '+target.name+'\n'+(result.admins.map((a:{name:string;role:string;jid?:string})=>`${a.name}${a.jid?' · '+a.jid.split('@')[0]:''} · ${a.role==='channel'?'somente este canal':'geral'}`).join('\n')||'Nenhum ADM cadastrado.')+'\n\n!daradm telefone | geral ou canal · !tiraradm telefone';
  }
  const match=cmd==='!daradm'?arg.match(/^(\d{10,15})\s*\|\s*(geral|canal)$/i):arg.match(/^(\d{10,15})$/);
  if(!match)return cmd==='!daradm'?'Use !daradm telefone | geral ou !daradm telefone | canal.':'Use !tiraradm telefone.';
  const phone=match[1]!;
  const aliases=cmd==='!daradm'?await actor.resolveMember?.(group,phone):[phone+'@s.whatsapp.net'];
  if(!aliases?.length)return '⚠️ Para conceder acesso, a pessoa precisa estar no canal escolhido.';
  const result=await api({...request,operation:cmd==='!daradm'?'grant':'revoke',targetAliases:aliases,...(cmd==='!daradm'?{role:match[2]!.toLowerCase()==='geral'?'admin':'channel'}:{})});
  return result.error?'⚠️ '+result.error:cmd==='!daradm'?'✅ Acesso salvo em '+target.name+': '+(result.role==='channel'?'somente este canal':'ADM geral')+'.':'✅ Acesso removido de '+target.name+'.';
 }
 if(['!forcarresultado','!resolver','!deletar','!vistoria'].includes(cmd)){
  if(!actor?.messageId)return 'Este comando precisa de uma mensagem verificada do ADM.';
  if(['!forcarresultado','!resolver'].includes(cmd)&&!/^\d+\s+\d{1,2}[xX×]\d{1,2}(?:\s+.{8,160})?$/.test(arg))return `Use ${cmd} CÓDIGO MxV motivo. Troque M e V pelos gols em números (mandante primeiro, visitante depois), sem espaços. Ao resolver, informe motivo com pelo menos 8 caracteres.`;
  if(cmd==='!deletar'&&!/^\d+$/.test(arg))return 'Use !deletar código para anular um placar sem fase posterior.';
  if(cmd==='!vistoria'&&arg)return 'Use !vistoria sem argumentos.';
  const result=await api({action:'admin-cup-command',source:actor.controlGroup,group,aliases:actor.aliases,messageId:actor.messageId,text:trimmed});
  return result.error?'⚠️ '+result.error:result.duplicate?'✅ Comando já registrado; consulte a Copa no grupo escolhido.':`✅ Comando registrado em ${target.name}. A resposta detalhada será enviada ao grupo da Copa. Use !central para acompanhar.`;
 }
 if(['!bloquear','!desbloquear','!bloqueados'].includes(cmd)){
  if(!actor)return 'Não foi possível validar o ADM desta central.';
  const request={action:'member-block',group:actor.controlGroup,aliases:actor.aliases};
  if(cmd==='!bloqueados'){
   const result=await api({...request,operation:'list'});
   if(result.error)return '⚠️ '+result.error;
   return '🚫 CONTAS BLOQUEADAS\n'+(result.members?.map((m:{display_name:string;reason:string},i:number)=>`${i+1}. ${m.display_name} · ${m.reason}`).join('\n')||'Nenhuma conta bloqueada.');
  }
  const parsed=arg.match(/^(\d{10,15})\s*\|\s*(.{8,160})$/s);
  if(!parsed||/[\r\n\x00-\x1f\x7f\u202a-\u202e*_~`]/.test(parsed[2]!))return `Use ${cmd} telefone com DDI e DDD | motivo (8 a 160 caracteres).`;
  const aliases=cmd==='!bloquear'?await actor.resolveMember?.(group,parsed[1]!)??null:[parsed[1]+'@s.whatsapp.net'];
  if(!aliases)return 'Conta não localizada no grupo selecionado. Confira DDI, DDD e a lista de participantes.';
  const result=await api({...request,operation:cmd==='!bloquear'?'block':'unblock',targetAliases:aliases,reason:parsed[2]!.trim()});
  return result.error?'⚠️ '+result.error:cmd==='!bloquear'?'🚫 Conta bloqueada. A ação ficou registrada.':'✅ Conta desbloqueada. A ação ficou registrada.';
 }
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
  const staged=(workspaces?.[group]??room).staged;
  return '🎛️ CENTRAL MLG\n📍 '+target.name+'\n🏆 Modelo ativo: '+current.activeCompetition+'\n'+(current.activeCup?'🎮 Copa em andamento: '+current.activeCup.participants+'/'+current.activeCup.size+' inscritos.':current.preparing?'⏳ Um ADM está escolhendo o formato no grupo da Copa.':'📣 Nenhuma Copa aberta.')+'\n'+(current.nextEdition?'🔢 Próxima edição: '+current.nextEdition+' (tentativas canceladas não ocupam número).\n':'')+(staged?'✅ Copa pronta: '+staged.name+' · '+staged.size+' vagas. Envie !novacopa no canal escolhido.':room.draft?'📝 Preparação salva: '+room.draft.name+(room.draft.size?' · '+room.draft.size+' vagas':' · vagas a definir'):'📝 Sem preparação em andamento.')+'\n\n!painel mostra os comandos.';
 }
 if(cmd==='!novacopa'){
  if(actor?.controlGroup===group&&room.staged){
   const staged=room.staged;
   const current=requireSuccess<any>(await api({action:'templates-list',group}));
   if(current.activeCup||current.preparing)return '⚠️ Já existe uma Copa ativa ou em preparação neste canal. Nenhuma nova Copa foi aberta.';
   const opened=requireSuccess<any>(await api({action:'cup-open',group,size:staged.size,proposal:{name:staged.name,teamKind:staged.teamKind,teams:staged.teams}}));
   if(!opened.opened)return '⚠️ O banco não confirmou a abertura. Consulte !central.';
   delete room.staged;await save();
   return '🏆 '+staged.name+(opened.edition?' · Edição '+opened.edition:'')+' aberta neste canal! O bot anunciará as '+staged.size+' vagas. Jogadores: !entrar.';
  }
  if((workspaces?.[group]??room).staged)return '📝 Copa já concluída para '+target.name+'. Um ADM deve enviar !novacopa no canal escolhido para abrir as inscrições.';
  const [config,list]=await Promise.all([api({action:'competition-get',group}),api({action:'templates-list',group})]);
  requireSuccess(config);requireSuccess(list);
  if(list.activeCup)return '⚠️ Já há uma Copa aberta em '+target.name+'. Consulte !central ou cancele com um motivo.';
  if(list.preparing)return '⏳ Um ADM já iniciou !novacopa no grupo dos jogadores. Termine ou cancele aquela preparação antes de começar outra.';
  if(room.draft)return '📝 Já existe uma preparação salva: '+room.draft.name+'. Use !revisar para continuar ou !descartar para começar outra.';
  room.draft={name:config.competition.name,teamKind:config.competition.teamKind,teams:config.competition.teams,size:null,teamsApproved:false};await save();
  return '🏆 PREPARAÇÃO INICIADA\n📍 '+target.name+'\n'+room.draft.name+'\n\n⚽ Quais times entram no sorteio desta Copa? Envie !equipes Time A | Time B | Time C | Time D (pode mandar até 200 em uma mensagem, separados por | ou linhas).\nPara usar os '+room.draft.teams.length+' times do modelo atual, envie !confirmartimes; use !times para conferir a lista. Depois defina !vagas 4/8/16/32 e envie !revisar. Nenhuma inscrição foi aberta.';
 }
 if(cmd==='!cancelarcopa'){
  if(arg.length<8)return 'Informe um motivo: !cancelarcopa motivo com ao menos 8 caracteres.';
  const result=requireSuccess<any>(await api({action:'cup-cancel',group,reason:arg}));
  return result.draft?'🚫 Escolha de formato iniciada no grupo da Copa cancelada. Nenhuma partida foi apagada.':result.cancelled?'🚫 '+(result.edition?'Edição '+result.edition:'Copa')+' cancelada em '+target.name+'. O número fica livre para a próxima Copa; histórico e recuperação preservados. O aviso será enviado ao grupo.':'⚠️ Não foi possível cancelar a Copa.';
 }
 if(cmd==='!anularcopa'){
  const match=arg.match(/^(\d+)\s+(.{8,160})$/s);if(!match)return 'Formato: !anularcopa número-da-edição motivo (mínimo 8 caracteres).';
  const edition=Number(match[1]);if(!Number.isSafeInteger(edition)||edition<1)return 'Número de edição inválido. Veja as edições com !historico no grupo da Copa.';
  const numbering=requireSuccess<any>(await api({action:'templates-list',group}));
  if(!Number.isSafeInteger(numbering.nextEdition))return '⚠️ A central está aguardando a atualização da numeração no banco. Para anular com segurança, use !anularcopa '+edition+' diretamente no grupo da Copa.';
  const result=requireSuccess<any>(await api({action:'cup-void',group,edition,reason:match[2]!.trim()}));
  return result.cancelled?'📋 Edição '+edition+' anulada em '+target.name+'. Número liberado; histórico preservado e jogos fora das estatísticas.':'⚠️ Edição não encontrada ou não encerrada.';
 }
 if(cmd==='!descartar'){const selected=workspaces?.[group]??room;if(!room.draft&&!selected.staged)return 'Não há preparação para descartar.';delete room.draft;delete selected.staged;await save();return '🗑️ Preparação descartada. Nenhuma Copa ou modelo salvo foi apagado.';}
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
  draft.teams=teams;draft.teamsApproved=true;if(draft.size&&teams.length<draft.size)draft.size=null;delete draft.reviewed;await save();return '✅ Lista salva: '+teams.length+' times. Use !times para conferir e !revisar antes de abrir.';
 }
 if(cmd==='!confirmartimes'){
  if(!validTeams(draft.teams)||draft.teams.length<4)return '⚠️ O modelo não tem ao menos quatro times válidos. Envie !equipes com a lista desta Copa.';
  draft.teamsApproved=true;delete draft.reviewed;await save();return '✅ Lista de '+draft.teams.length+' times do modelo confirmada para esta Copa. Use !times para conferir.';
 }
 if(cmd==='!remover'){
  const i=draft.teams.findIndex(t=>clean(t)===clean(arg));if(i<0)return 'Time não encontrado. Use !times e informe o nome exato.';
  draft.teams.splice(i,1);draft.teamsApproved=true;if(draft.size&&draft.teams.length<draft.size)draft.size=null;delete draft.reviewed;await save();return '✅ '+arg+' removido da preparação. Restam '+draft.teams.length+' times.';
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
  if(!draft.teamsApproved)return '⚽ Confirme os times desta Copa: envie !equipes com a lista completa ou !confirmartimes para reutilizar o modelo.';
  if(draft.teams.length<4||!validTeams(draft.teams)||!draft.size||draft.size>draft.teams.length)return '⚠️ Revise a lista (mínimo 4 times diferentes) e escolha !vagas 4, 8, 16 ou 32.';
  draft.reviewed=fingerprint(draft);draft.reviewedAt=now;await save();
  return '🔎 CONFERÊNCIA ANTES DE ABRIR\n📍 Grupo: '+target.name+'\n🏆 Nome: '+draft.name+'\n🎲 Categoria: '+label(draft.teamKind)+'\n👥 Vagas: '+draft.size+'\n⚽ Times ('+draft.teams.length+'): '+draft.teams.slice(0,20).join(' · ')+(draft.teams.length>20?'\nVeja os demais com !times 2.':'')+'\n\nSe estiver correto, envie !concluir em até 10 minutos. Depois um ADM publica no canal escolhido com !novacopa. Para abrir imediatamente pela central: !abrircopa.';
 }
 if(cmd==='!concluir'){
  if(!draft.size||draft.reviewed!==fingerprint(draft)||!draft.reviewedAt||now-draft.reviewedAt>600_000)return 'Antes de concluir, defina !vagas e envie !revisar. A revisão vale 10 minutos e expira ao editar.';
  if(!workspaces)return '⚠️ A central não conseguiu salvar a preparação para o canal. Tente novamente.';
  const current=requireSuccess<any>(await api({action:'templates-list',group}));
  if(current.activeCup||current.preparing)return '⚠️ Há Copa ativa ou preparação em andamento no canal. Encerre ou cancele antes de concluir.';
  const destination=workspaces[group]??(workspaces[group]={});
  destination.staged={name:draft.name,teamKind:draft.teamKind,teams:[...draft.teams],size:draft.size};
  delete room.draft;await save();
  return '✅ '+draft.name+' pronta para '+target.name+'. No canal escolhido, um ADM envia !novacopa para abrir '+destination.staged.size+' vagas. Até lá, ninguém pode entrar. Use !descartar para cancelar a preparação.';
 }
 if(cmd==='!abrircopa'){
  if(!draft.size||draft.reviewed!==fingerprint(draft)||!draft.reviewedAt||now-draft.reviewedAt>600_000)return 'Antes de abrir, defina !vagas e envie !revisar. A revisão vale 10 minutos e expira ao editar.';
  const current=requireSuccess<any>(await api({action:'templates-list',group}));if(current.activeCup||current.preparing)return '⚠️ Este grupo já tem Copa ativa ou formato em preparação. Nenhuma outra foi aberta.';
  const original=requireSuccess<any>(await api({action:'competition-get',group})).competition;
  const changed=original.name!==draft.name||original.teamKind!==draft.teamKind||JSON.stringify(original.teams)!==JSON.stringify(draft.teams);
  const proposal=changed?{name:draft.name,teamKind:draft.teamKind,teams:draft.teams}:undefined;
  const opened=requireSuccess<any>(await api({action:'cup-open',group,size:draft.size,...(proposal?{proposal}:{})}));
  if(!opened.opened)return '⚠️ O banco não confirmou a abertura. Consulte !central.';
  delete room.draft;delete (workspaces?.[group]??room).staged;await save();return '🏆 '+draft.name+(opened.edition?' · Edição '+opened.edition:'')+' aberta em '+target.name+' com '+draft.size+' vagas! O bot anunciará as inscrições no grupo da Copa. Lá os jogadores usam !entrar.';
 }
 return 'Comando da central não reconhecido. Use !painel para ver os comandos deste grupo.';
}
