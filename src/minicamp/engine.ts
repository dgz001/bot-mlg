import {careers,careerText,normalizeName} from './career.ts';
import { randomInt, randomUUID } from 'node:crypto';

// Pure domain boundary. The production adapter MUST resolve identities, load
// permissions and commit state + inbox + audit + outbox in one DB transaction.
// This module does not provide a database, transport or operational durability.
export const commandMenu='📋🎮 COMANDOS MLG\n\n🍿 RESENHA EM CANAL PRÓPRIO\nNo grupo de resenha, use !bot mensagem. Aqui ficam os comandos da Copa.\n\n⚔️ RETROSPECTO REAL\n!confronto jogador A x jogador B\nOu marque as duas contas: !confronto @jogador1 x @jogador2\n!titulo nome — títulos e conquistas; sem nome, consulta sua conta\n!stats — seus números\n!stats Nome completo — outro participante\n!jornada [nome ou @conta] — sua trajetória completa\n!arquivo [página] — inscritos nas últimas Copas\n!moral [página] — pontos e conquistas\n!participantes [edição] — inscritos\n!ranking • !campeoes • !historico • !minhascopas (use 2 para a próxima página)\n\n🏆 MINICAMP\n!teste — configuração e situação da Copa\n!supabase — verificar a conexão com o banco\n!times [página] — equipes disponíveis para sorteio\n!entrar — inscrição\n!sair — libera vaga; após sorteio, propõe W.O. 3x0 para confirmação\n!copa — todos os confrontos, separados por lado e fase\n!chave A ou !chave B — caminho de um lado até a final\n!sorteio — conferir os jogos sorteados\n!jogo código — partida\nMande o print no grupo; !resultado 4x3 — mandante x visitante\n!confirmar 4x3 • !contestar — confronto único\nQualquer jogador da dupla pode registrar e confirmar; ADM corrige erros.\nSe houver dúvida, acrescente o código da partida.\n\n🔐 SOMENTE ADMs SELECIONADOS NO PAINEL\n!modelos • !ativarmodelo Nome — escolher campeonato deste grupo\n!novacopa → !formato 4, 8, 16 ou 32\n!cancelar copa\n!forcarresultado código 4x3 motivo\n!resolver código 4x3 motivo\n!deletar código — anular resultado sem fase posterior\n!deletar título código-da-final — retirar título e reabrir final\n!anularcopa número-da-edição — retirar uma Copa de teste das estatísticas\n!registrar Nome | @conta — cadastro\n!associar Nome | @conta — nome da conta\n!sincronizarcontas — conferir vínculos\n!revisarnumeros — conferir estatísticas pelo histórico\n!vistoria — situação e pendências da Copa\n!config\n\n📊 Retrospectos usam partidas confirmadas neste bot. Palpites não alteram resultados.';
export type Participant = { userId: string; name: string; club?: string };
export type Result = {
  home: number; away: number; author: string; at: number;
  status: 'pending' | 'disputed' | 'confirmed';
  confirmedBy?: string; disputedBy?: string; reason?: string;
};
export type Match = {
  code: number; round: number; position: number; home: string; away: string;
  status: 'scheduled' | 'pending' | 'disputed' | 'confirmed';
  results: Result[]; winner?: string;
};
export type Cup = {
  id: string; groupId: string; createdBy: string; createdAt: number;
  size: number; competitionName?: string; teamKind?: 'clube'|'seleção'|'misto'; status: 'open' | 'playing' | 'completed' | 'cancelled';
  participants: Participant[]; matches: Match[]; champion?: string; completedAt?: number; cancellationReason?: string;
};
type Audit = {
  actor: string; groupId: string; cupId: string | null; matchCode?: number; at: number;
  action: string; before: string; after: string; outcome: 'accepted';
};
export type State = {
  groups: Record<string, { authorized: boolean; admins: string[]; clubs: string[]; competitionName?: string; teamKind?: 'clube'|'seleção'|'misto'; formatSize?: number|null }>;
  profiles?: Record<string,Record<string,string>>;
  drafts: Record<string, { ownerId: string; expiresAt: number }>;
  cups: Record<string, Cup>;
  processed: Record<string, true>;
  nextCode: number;
  audit: Audit[];
};
export type Event = { id: string; groupId: string; userId: string; name: string; text: string; at: number };
export type Environment = { id(): string; shuffle<T>(items: T[]): T[] };
export const environment: Environment = {
  id: randomUUID,
  shuffle<T>(items: T[]): T[] {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  },
};
export function emptyState(): State {
  return { groups: {}, drafts: {}, cups: {}, processed: {}, nextCode: 100, audit: [] };
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function cleanName(value: string) {
  return value.replace(/[\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069*_~`]/g, '').trim().slice(0, 60) || 'Participante';
}
function roundName(count: number): string {
  return ({ 2: 'FINAL', 4: 'SEMIFINAL', 8: 'QUARTAS DE FINAL', 16: 'OITAVAS DE FINAL', 32: '16 AVOS DE FINAL' } as Record<number, string>)[count] ?? `RODADA ${count}`;
}
function player(cup: Cup, id: string): Participant {
  const value = cup.participants.find(p => p.userId === id);
  requireThat(value, 'Participante não encontrado.');
  return value;
}
function describe(cup: Cup, m: Match): string {
  const home = player(cup, m.home), away = player(cup, m.away);
  return `#${m.code} · ${home.name} (${home.club}) × ${away.name} (${away.club})`;
}
function matchCard(cup:Cup,m:Match,status?:string):string{
 const home=player(cup,m.home),away=player(cup,m.away);
 return `🎮 JOGO ${m.code}${status?' · '+status:''}\n${home.name} · ${home.club}\n       ×\n${away.name} · ${away.club}`;
}
const matchStatus=(status:Match['status'])=>({scheduled:'a jogar',pending:'aguardando confirmação',disputed:'contestado',confirmed:'confirmado'} as const)[status];
function bracket(cup: Cup, side?: 'A'|'B'): string {
 if (!cup.matches.length) return 'Aguardando inscrições e sorteio.';
 const rounds=Math.log2(cup.size);
 const sections: string[]=[];
 for (const label of (side?[side]:['A','B'] as const)) {
  const lines=[`🔹 LADO ${label} · ${cup.size/2} participantes`];
  for(let round=0;round<rounds-1;round++){
   const count=cup.size/2**(round+1);
   const start=label==='A'?0:count/2;
   const games: string[]=[];
   for(let position=start;position<start+count/2;position++){
    const match=cup.matches.find(m=>m.round===round&&m.position===position);
    if(match){games.push(matchCard(cup,match,matchStatus(match.status))+(match.winner?`\n✅ Avança: ${player(cup,match.winner).name}`:''));continue;}
    const previous=cup.matches.filter(m=>m.round===round-1);
    const slot=(p:number)=>{const m=previous.find(item=>item.position===p);return m?.winner?player(cup,m.winner).name:m?`Vencedor jogo ${m.code}`:'A definir';};
    games.push(`🎮 PRÓXIMO JOGO\n${slot(position*2)} × ${slot(position*2+1)}`);
   }
   lines.push(`\n⚔️ ${roundName(cup.size/2**round)}\n${games.join('\n\n')}`);
  }
  sections.push(lines.join('\n'));
 }
 const final=cup.matches.find(m=>m.round===rounds-1);
 const finalists=(position:number)=>{
  const match=cup.matches.find(m=>m.round===rounds-2&&m.position===position);
  return match?.winner?player(cup,match.winner).name:match?`Vencedor jogo ${match.code}`:'A definir';
 };
 const title=final?matchCard(cup,final,matchStatus(final.status))+(final.winner?`\n👑 Campeão: ${player(cup,final.winner).name}`:''):`🎮 ${finalists(0)} × ${finalists(1)}`;
 sections.push(`🏆 FINAL · Lado A × Lado B\n${title}`);
 return sections.join('\n\n');
}
function score(m: Match): Result {
  const value = m.results.at(-1);
  requireThat(value, 'Nenhum resultado pendente.');
  return value;
}
function parseScore(value: string | undefined): { home: number; away: number } {
  requireThat(value && /^\d{1,2}x\d{1,2}$/i.test(value), 'Formato: !resultado código 3x2');
  const [home, away] = value.toLowerCase().split('x').map(Number) as [number, number];
  requireThat(home !== away, 'Mata-mata não permite empate; informe o placar decisivo acordado.');
  return { home, away };
}
function addRound(s: State, cup: Cup, ids: string[], round: number): string {
  const output: string[] = [`⚔️ ${roundName(ids.length).toUpperCase()} · ${ids.length / 2} ${ids.length===2?'jogo':'jogos'}`];
  for (let i = 0; i < ids.length; i += 2) {
    requireThat(Number.isSafeInteger(s.nextCode) && s.nextCode < Number.MAX_SAFE_INTEGER, 'Limite de códigos atingido.');
    const match: Match = { code: s.nextCode++, round, position: i / 2, home: ids[i]!, away: ids[i + 1]!, status: 'scheduled', results: [] };
    cup.matches.push(match);
    output.push(matchCard(cup, match));
  }
  output.push('📌 O primeiro nome é o mandante; informe o placar nessa ordem.\n📸 Mandem o print e usem !resultado 4x3 → !confirmar.\nOs dois jogadores podem confirmar.');
  return output.join('\n\n');
}
// Stable choices survive retries/restarts without changing sporting decisions.
const classifiedCheers = [
  '🔥 Passagem carimbada! O próximo desafio já está no radar.',
  '🎮 Segue vivo na briga pela taça. Respira e prepara o controle!',
  '🚀 Mais um passo! A torcida já pode marcar presença na próxima fase.',
  '🍿 Continua no campeonato e no assunto do grupo!',
  '⚽ A caminhada segue. Guarda um pouco desse futebol pra próxima!',
  '📣 Pode comemorar! Depois tem mais disputa pela frente.',
  '🏆 A taça ficou um pouquinho mais perto!',
  '😎 Classificação no bolso. Agora é foco no próximo jogo!',
];
const eliminatedCheers = [
  '🤝 Valeu pela disputa! Na próxima Copa tem revanche.',
  '💪 Hoje acabou a caminhada, mas a próxima inscrição já merece teu nome!',
  '🍿 Agora é arquibancada e resenha. Volta pra buscar a taça na próxima!',
  '🎮 Guarda o controle com carinho: ainda tem muita Copa pela frente!',
  '⚽ Cabeça erguida! Obrigado por fazer parte dessa edição.',
  '🔥 A próxima chance começa com outro !entrar. Te esperamos!',
  '👏 Valeu pelo jogo! A comunidade ganha com a participação de todo mundo.',
  '😄 A taça escapou dessa vez. A vaga na resenha continua garantida!',
];
const championCheers = [
  '🎉 Solta o grito! Essa edição tem dono e a festa está liberada!',
  '👑 Pode levantar a taça! Hoje o destaque do grupo é você!',
  '🏆 Fecha a edição com chave de ouro! Parabéns pela conquista!',
  '📣 A arquibancada pode fazer barulho: temos campeão!',
  '🔥 Do primeiro jogo até a taça. Que final de caminhada!',
  '🥳 Pode comemorar com a rapaziada! O título já está no histórico.',
  '😎 Controle na mão, taça na estante. Parabéns, campeão!',
  '🎊 A Copa terminou e a celebração começou. Aproveita esse título!',
];
const pendingCheers = [
  '🎮 O jogo acabou; confiram o print e liberem a próxima fase.',
  '📋 Placar anotado. Um dos dois jogadores pode concluir a confirmação.',
  '⏳ A chave aguarda !confirmar; ninguém avançou ainda.',
  '🤝 Conferiu o print? Qualquer jogador da dupla pode confirmar.',
  '⚽ Placar na súmula; a classificação vem após !confirmar.',
  '📸 Print no grupo, placar anotado. Falta confirmar para seguir.',
];
const openingCheers = [
  '🎙️ A arena abriu as portas. Chame a turma para completar a chave!',
  '🏟️ Nova edição no ar. Cada inscrição aproxima o primeiro confronto.',
  '🎮 Controle na mão: assim que lotar, o sorteio define clubes e jogos.',
  '📣 Tem vaga na disputa! Convide quem está pronto para jogar.',
];
function advance(s: State, cup: Cup, match: Match, at: number): string[] {
  const r = score(match);
  match.winner = r.home > r.away ? match.home : match.away;
  match.status = 'confirmed';
  const winner = player(cup, match.winner);
  const loser = player(cup, match.winner === match.home ? match.away : match.home);
  const isFinal = cup.size / 2 ** match.round === 2;
  const notices = [`✅ RESULTADO CONFIRMADO\n#${match.code}\n${player(cup, match.home).name} ${r.home} x ${r.away} ${player(cup, match.away).name}\n${isFinal ? `🏆 ${winner.name} é campeão!\n🥈 ${loser.name} fica com o vice. Valeu pela disputa até a final!` : `🏆 ${winner.name} está classificado!\n${classifiedCheers[match.code % classifiedCheers.length]}\n\n${loser.name} está eliminado.\n${eliminatedCheers[match.code % eliminatedCheers.length]}`}`];
  const current = cup.matches.filter(m => m.round === match.round).sort((a, b) => a.position - b.position);
  if (!current.every(m => m.status === 'confirmed')) return notices;
  if (current.length === 1) {
    cup.champion = match.winner;
    cup.status = 'completed'; cup.completedAt = at;
    const campaign = cup.matches.filter(m => m.home === cup.champion || m.away === cup.champion)
      .sort((a, b) => a.round - b.round)
      .map(m => {
        const result = score(m);
        return `${roundName(cup.size / 2 ** m.round)}: ${m.home === cup.champion ? result.home : result.away}x${m.home === cup.champion ? result.away : result.home}`;
      });
    const titles=Object.values(s.cups).filter(c=>c.groupId===cup.groupId&&c.status==='completed'&&c.champion===cup.champion).length;
    notices.push(`🏆 CAMPEÃO DO ${cup.competitionName?.toUpperCase()??"MINICAMP MLG"}\n👑 ${winner.name} · ${winner.club}\n${championCheers[match.code % championCheers.length]}\n\n🏅 ${titles===1?'Primeira taça registrada!':`${titles} títulos registrados no grupo.`}\n📊 Caminho até o título\n${campaign.join('\n')}`);
  } else {
    requireThat(!cup.matches.some(m => m.round === match.round + 1), 'Rodada já existe.');
    notices.push(addRound(s, cup, current.map(m => m.winner!), match.round + 1));
  }
  return notices;
}

export function apply(input: State, event: Event, env: Environment = environment): { state: State; notices: string[] } {
  requireThat(event.id && event.groupId && event.userId && Number.isFinite(event.at), 'Evento inválido.');
  const group = Object.hasOwn(input.groups, event.groupId) ? input.groups[event.groupId] : undefined;
  requireThat(group?.authorized, 'Grupo não autorizado.');
  const eventKey = JSON.stringify([event.groupId, event.userId, event.id]);
  if (Object.hasOwn(input.processed, eventKey)) return { state: input, notices: [] };
  requireThat(event.text.length <= 1000, 'Comando muito longo.');
  const s = structuredClone(input);
  const admin = group.admins.includes(event.userId);
  const needAdmin = () => requireThat(admin, 'Somente ADM autorizado.');
  const active = () => Object.values(s.cups).find(c => c.groupId === event.groupId && ['open', 'playing'].includes(c.status));
  const getMatch = (code: string | undefined): { cup: Cup; match: Match } => {
    requireThat(code && /^\d+$/.test(code) && Number.isSafeInteger(Number(code)), 'Código inválido.');
    for (const cup of Object.values(s.cups)) {
      if (cup.groupId !== event.groupId) continue;
      const match = cup.matches.find(m => m.code === Number(code));
      if (match) return { cup, match };
    }
    throw new Error('Partida não encontrada neste grupo.');
  };
  const audit = (action: string, cup: Cup, before: string, matchCode?: number) => {
    s.audit.push({ actor: event.userId, groupId: event.groupId, cupId: cup.id, matchCode, at: event.at, action, before, after: JSON.stringify(cup), outcome: 'accepted' });
  };
  const competitionName=group.competitionName??'Minicamp MLG';
  const teamKind=group.teamKind??'clube';
  const teamPlural=teamKind==='seleção'?'seleções':teamKind==='misto'?'times':'clubes';
  const teamSingular=teamKind==='seleção'?'seleção':teamKind==='misto'?'time':'clube';
  const normalized = event.text.trim().replace(/^!forçar\s+resultado/i,'!forcarresultado').replace(/^!forcar\s+resultado/i,'!forcarresultado').replace(/^!deletar\s+t[ií]tulo/i,'!deletartitulo').replace(/^!cancelar\s+copa$/i,'!cancelarcopa').replace(/(\d)\s*[xX×]\s*(\d)/g,'$1x$2').replace(/^!formato\s+(4|8|16|32)$/i, (_, n) => (({ '4':'1','8':'2','16':'3','32':'4' } as Record<string,string>)[n]!));
  const parts = normalized.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  let notices: string[] = [];
  const cheer=['🔥 Chegou pra disputar a taça ou pra render resenha?','🎮 Agora é no controle! A torcida já está de olho.','🍿 Mais um nome na disputa. Vai faltar cadeira nessa arquibancada!','⚽ Tá dentro! O discurso de campeão a gente deixa pra final.','🏆 Vaga garantida. Agora chama aquele rival que fala muito!','📣 A lista está esquentando! Essa Copa promete.'][[...event.id].reduce((n,c)=>n+c.charCodeAt(0),0)%6];
  const profiles=s.profiles?.[event.groupId]??{};
  const groupCups=Object.values(s.cups).filter(c=>c.groupId===event.groupId);
  const editions=()=>[...groupCups].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  const edition=(cup:Cup)=>editions().findIndex(c=>c.id===cup.id)+1;
  const cupLabel=(cup:Cup)=>`Edição ${edition(cup)}`;
  const cupStatus=(cup:Cup)=>({open:'inscrições abertas',playing:'em andamento',completed:'encerrada',cancelled:'anulada'} as const)[cup.status];
  const cupDate=(cup:Cup)=>new Date(cup.completedAt??cup.createdAt).toLocaleDateString('pt-BR',{timeZone:'UTC'});
  const resolveCup=(value:string|undefined)=>groupCups.find(c=>c.id===value)??(/^\d+$/.test(value??'')?editions()[Number(value)-1]:undefined);
  const pageOf=(value:string|undefined,total:number,command:string)=>{
    const page=Number(value??1);requireThat(Number.isSafeInteger(page)&&page>=1&&page<=Math.max(1,Math.ceil(total/6)),`Página inválida. Use ${command} 1 até ${command} ${Math.max(1,Math.ceil(total/6))}.`);return page;
  };
  const variation=[...event.id].reduce((n,c)=>n+c.charCodeAt(0),0);
  if(cmd==='!registrarid'||cmd==='!associarid'){
    needAdmin();const target=parts[1];const name=cleanName(parts.slice(2).join(' '));
    requireThat(target&&parts.length>2&&name!=='Participante','Formato: !registrar Nome do técnico | @conta');
    const people=new Map<string,string>();for(const c of groupCups)for(const p of c.participants)people.set(p.userId,p.name);for(const [id,n] of Object.entries(profiles))people.set(id,n);
    requireThat(![...people].some(([id,n])=>id!==target&&normalizeName(n)===normalizeName(name)),'Nome já pertence a outra conta. Nenhum histórico foi transferido.');
    if(cmd==='!registrarid')requireThat(!Object.hasOwn(profiles,target),'Nome desta conta já cadastrado. Use !associar Nome | @conta para atualizar.');
    s.profiles??={};s.profiles[event.groupId]??={};const before=JSON.stringify(profiles);s.profiles[event.groupId]![target]=name;
    s.audit.push({actor:event.userId,groupId:event.groupId,cupId:null,at:event.at,action:cmd.slice(1),before,after:JSON.stringify(s.profiles[event.groupId]),outcome:'accepted'});
    notices.push(`🪪 IDENTIDADE NA ARENA\n${name} está associado à conta marcada.\n✅ Cadastro salvo. Jogos e títulos continuam na mesma conta.`);
  } else if(cmd==='!registrar'||cmd==='!associar'){
    needAdmin();throw Error('Formato: '+cmd+' Nome do técnico | @conta — marque uma conta do grupo.');
  } else if(cmd==='!contasverificadas'){
    needAdmin();const counts=parts.slice(1).map(Number);requireThat(counts.length===4&&counts.every(n=>Number.isSafeInteger(n)&&n>=0),'Comando inválido.');
    notices.push(`🔗 CONEXÕES DA ARENA\n✅ ${counts[0]} cadastros conferidos.\n🪪 ${counts[1]} identificadores verificados adicionados.\n⚠️ ${counts[2]} conflitos preservados para revisão.\nAmostra: ${counts[3]} membros (limite 100 por execução). Só pares reconhecidos pelo WhatsApp são associados. Jogos e títulos permanecem intactos.`);
    s.audit.push({actor:event.userId,groupId:event.groupId,cupId:null,at:event.at,action:'sincronizarcontas',before:'null',after:JSON.stringify(counts),outcome:'accepted'});
  } else if(cmd==='!sincronizarcontas'){
    needAdmin();notices.push('🔗 CONTAS CONFERIDAS\nOs vínculos verificados pelo WhatsApp são sincronizados automaticamente ao receber comandos. Contas conflitantes não são unidas por nome.\nPara definir o nome de uma conta: !registrar Nome | @conta.');
  } else if(cmd==='!revisarnumeros'){
    needAdmin();const rows=careers(groupCups,profiles);notices.push(`🧮 REVISÃO DA ARENA\n✅ ${rows.length} carreiras reconstruídas a partir do histórico confirmado.\n🎮 ${rows.reduce((n,p)=>n+p.games,0)/2} partidas contabilizadas.\n🏆 ${rows.reduce((n,p)=>n+p.titles,0)} títulos válidos.\nOs números são recalculados em cada consulta; não existem contadores antigos para acumular duplicações.`);
  } else if(cmd==='!participantes'){
    const cup=parts[1]?resolveCup(parts[1]):active()??[...groupCups].sort((a,b)=>b.createdAt-a.createdAt)[0];
    requireThat(cup,'Nenhuma Copa encontrada neste grupo.');notices.push(`🏟️ INSCRITOS · ${cupLabel(cup)}\n👥 ${cup.participants.length}/${cup.size}\n\n`+(cup.participants.map((p,i)=>`${i+1}. ${profiles[p.userId]??p.name} · ${p.club??'clube a sortear'}`).join('\n')||'Lista aberta. Mande !entrar para disputar.'));
  } else if(cmd==='!arquivo'){
    requireThat(parts.length<=2,'Formato: !arquivo ou !arquivo número-da-página');
    const rows=groupCups.filter(c=>c.status!=='cancelled').sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)).flatMap(c=>c.participants.map((p,i)=>({cup:c,participant:p,position:i+1})));
    const total=Math.max(1,Math.ceil(rows.length/8));const page=Number(parts[1]??1);
    requireThat(Number.isSafeInteger(page)&&page>=1&&page<=total,`Página inválida. Use !arquivo 1 até !arquivo ${total}.`);
    const slice=rows.slice((page-1)*8,page*8);let last='';const lines:string[]=[];
    for(const {cup,participant,position} of slice){
      if(last!==cup.id){lines.push(`\n🏆 ${cupLabel(cup)} · ${cupStatus(cup)}`);last=cup.id;}
      lines.push(`${position}. ${profiles[participant.userId]??participant.name}${participant.club?' · '+participant.club:''}`);
    }
    notices.push(`📚 ARQUIVO DA ARENA · ${page}/${total}\n${lines.join('\n')||'Ainda não há inscrições registradas neste grupo.'}\n\nSomente Copas deste grupo; edições anuladas ficam fora.${page<total?` Próxima página: !arquivo ${page+1}`:''}`);
  } else if(cmd==='!vistoria'){
    needAdmin();requireThat(parts.length===1,'Formato: !vistoria');
    const cup=active();const matches=cup?.matches??[];
    const pending=matches.filter(m=>m.status==='pending');const disputes=matches.filter(m=>m.status==='disputed');
    const scheduled=matches.filter(m=>m.status==='scheduled');const confirmed=matches.filter(m=>m.status==='confirmed');
    const clubs=cup?.participants.map(p=>p.club).filter((c):c is string=>!!c)??[];
    const duplicateClubs=new Set(clubs).size!==clubs.length;
    const missingClubs=cup?.status==='playing'&&clubs.length!==cup.participants.length;
    const next=disputes.length?`⚖️ Resolver disputa da partida #${disputes[0]!.code} com outro ADM.`:pending.length?`📝 Partida #${pending[0]!.code}: qualquer jogador da dupla pode confirmar; se houver erro no print, ADM corrige.`:scheduled.length?`🎮 Próximo confronto: !jogo ${scheduled[0]!.code}.`:cup?.status==='open'?`📣 Faltam ${cup.size-cup.participants.length} inscrições. Use !entrar.`:'🏆 Nenhuma Copa ativa. Use !novacopa quando a turma estiver pronta.';
    notices.push(`🛡️ VISTORIA · ${competitionName.toUpperCase()}\n${cup?`${cupLabel(cup)} · ${cupStatus(cup)}\n👥 ${cup.participants.length}/${cup.size} inscritos\n🎮 ${scheduled.length} partidas a jogar · 📝 ${pending.length} aguardando confirmação\n⚖️ ${disputes.length} contestadas · ✅ ${confirmed.length} confirmadas\n${duplicateClubs||missingClubs?'⚠️ Sorteio incompleto ou com clubes repetidos: confira antes de prosseguir.':cup.status==='open'?'🎲 Sorteio acontece quando completar as vagas.':'✅ Sorteio sem clubes repetidos.'}`:'Nenhuma Copa ativa neste grupo.'}\n\n${next}\n📌 Consulta somente: nenhuma Copa ou estatística foi alterada.`);
  } else if(cmd==='!carreira'||cmd==='!jornada'||cmd==='!carreiraid'||cmd==='!moral'){
    const rows=careers(groupCups,profiles);
    if(cmd==='!moral'){
      const page=Number(parts[1]??1);requireThat(Number.isSafeInteger(page)&&page>0&&page<=Math.max(1,Math.ceil(rows.length/10)),'Formato: !moral número-da-página');
      notices.push(`⭐ MORAL NA ARENA · ${page}/${Math.max(1,Math.ceil(rows.length/10))}\n`+(rows.slice((page-1)*10,page*10).map((p,i)=>`${(page-1)*10+i+1}. ${p.name} — ${p.points} pts\n🏆 ${p.titles} · 🥈 ${p.vices} · ✅ ${p.wins}`).join('\n\n')||'A disputa ainda vai começar!')+'\n\nPontuação: título 100 · vice 40 · vitória 5 · empate 2 · cada jogo dos recordes invicto e de vitórias 2. Medalhas: primeira taça +10, sequência de 5 vitórias +15, 10 invicto +25. Bônus uma vez por conquista.\nMais posições: !moral 2');
    }else{
      const search=normalizeName(parts.slice(1).join(' '));const found=cmd==='!carreiraid'?rows.filter(p=>p.id===parts[1]):search?rows.filter(p=>normalizeName(p.name)===search):rows.filter(p=>p.id===event.userId);
      requireThat(found.length<=1,'Nome ambíguo. Marque a conta com !carreira @conta.');
      requireThat(found.length||!search,'Nome não encontrado. Use !jornada ou marque a conta.');
      const p=found[0]??careers([],{[event.userId]:cleanName(event.name)})[0]!;notices.push(careerText(p,rows.findIndex(r=>r.id===p.id)+1));
    }
  } else if(cmd==='!supabase'){
    requireThat(parts.length===1,'Formato: !supabase');
    notices.push('🗄️ DIAGNÓSTICO SUPABASE\n✅ Comando reconhecido em grupo autorizado.');
  } else if(cmd==='!teste'){
    requireThat(parts.length===1,'Formato: !teste');
    const count=new Set(group.clubs.map(c=>c.trim()).filter(Boolean)).size;
    const cup=active();
    const pending=cup?.matches.filter(m=>m.status==='pending').length??0;
    const disputed=cup?.matches.filter(m=>m.status==='disputed').length??0;
    notices.push(`🧪 SITUAÇÃO · ${competitionName.toUpperCase()}\n${group.admins.length?'✅':'⚠️'} ADMs cadastrados: ${group.admins.length}\n${count>=(group.formatSize??4)?'✅':'⚠️'} ${teamPlural[0]!.toUpperCase()+teamPlural.slice(1)} disponíveis: ${count} (mínimo ${group.formatSize??4} para esta chave)\n🏆 ${cup?`${cupLabel(cup)} · ${cupStatus(cup)} · ${cup.participants.length}/${cup.size} inscritos`:'Nenhuma Copa ativa.'}\n📝 Placares pendentes: ${pending} · ⚖️ Contestações: ${disputed}\n${cup?'🎮 Continue a edição atual antes de abrir outra.':group.admins.length&&count>=(group.formatSize??4)?'📣 Pronto para !novacopa.':'⚠️ ADM: revise a configuração antes de abrir uma Copa.'}\nConsulta sem alterações nos jogos ou estatísticas.`);
  } else if(cmd==='!clubes'||cmd==='!selecoes'||cmd==='!times'){
    const total=Math.max(1,Math.ceil(group.clubs.length/20));const page=Number(parts[1]??1);
    requireThat(parts.length<=2&&Number.isSafeInteger(page)&&page>=1&&page<=total,`Página inválida. Use !clubes 1 até !clubes ${total}.`);
    notices.push(`🎲 ${teamPlural.toUpperCase()} · ${competitionName.toUpperCase()} · ${page}/${total}\n`+group.clubs.slice((page-1)*20,page*20).map((club,i)=>(page-1)*20+i+1+'. '+club).join('\n')+`\n\nSorteio sem repetição entre inscritos.${page<total?` Próxima página: !clubes ${page+1}`:''}`);
  } else if(cmd==='!comandos'){
    notices.push(competitionName==='Minicamp MLG'?commandMenu:`🏆 ${competitionName.toUpperCase()}\n\n🎮 JOGADORES\n!times [página] — times disponíveis\n!entrar — disputar a Copa\n!sair — liberar sua vaga antes do sorteio\n!copa — todos os confrontos, separados por lado e fase\n!chave A ou !chave B — caminho de um lado até a final\n!sorteio — conferir os jogos sorteados\n!jogo código — situação e placar de uma partida\n!resultado 4x3 — placar mandante x visitante (enviem o print no grupo)\n!confirmar — qualquer jogador da partida confirma\n!contestar código — contestar antes da confirmação\n!stats • !ranking • !campeoes • !historico — números deste grupo\n\n🔐 ADM\n!modelos • !ativarmodelo Nome — escolher campeonato deste grupo\n!painel na central dos ADMs: guia completo de gestão\n!novacopa → !formato 4, 8, 16 ou 32\n!cancelar copa — cancelar edição\n!resolver código 4x3 motivo — corrigir placar\n!forcarresultado código 4x3 motivo — decidir pendência\n\n🎲 O sorteio começa automaticamente quando todas as vagas forem ocupadas.`);
  } else if(cmd==='!confronto'||cmd==='!confrontoids'){
    const cups=Object.values(s.cups).filter(c=>c.groupId===event.groupId&&c.status!=='cancelled');
    const people=new Map<string,string>();for(const c of cups)for(const p of c.participants)people.set(p.userId,p.name);for(const [id,n] of Object.entries(profiles))people.set(id,n);
    const normalize=(v:string)=>v.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
    let ids:string[];
    if(cmd==='!confrontoids'){ids=parts.slice(1);requireThat(ids.length===2&&ids.every(id=>people.has(id)),'Nome ainda não registrado em Copas deste grupo. Entre em uma Copa antes de consultar o retrospecto.');}
    else{
      const sides=parts.slice(1).join(' ').split(/\s+(?:x|vs|contra)\s+/i);
      requireThat(sides.length===2,'Formato: !confronto Nome completo x Nome completo, ou marque duas contas.');
      ids=sides.map(side=>{
        const q=normalize(side);
        const matches=[...people].filter(([,name])=>normalize(name)===q||normalize(name).split(' ')[0]===q);
        requireThat(matches.length===1,'Nome não encontrado ou ambíguo. Use o nome completo registrado na Copa ou marque as duas contas.');
        return matches[0]![0];
      });
    }
    const [a,b]=ids;requireThat(a!==b,'Escolha dois jogadores diferentes.');
    const games=cups.flatMap(c=>c.matches.filter(m=>m.status==='confirmed'&&((m.home===a&&m.away===b)||(m.home===b&&m.away===a))));
    let ga=0,gb=0,wa=0,wb=0;
    for(const m of games){const r=score(m);ga+=m.home===a?r.home:r.away;gb+=m.home===b?r.home:r.away;wa+=Number(m.winner===a);wb+=Number(m.winner===b);}
    notices.push('⚔️ RETROSPECTO MLG\n'+people.get(a!)+' 🆚 '+people.get(b!)+'\n🎮 Jogos: '+games.length+'\n🏅 Vitórias: '+wa+' x '+wb+'\n⚽ Gols: '+ga+' x '+gb+'\n'+(games.length?'🍿 O placar está nos registros. A resenha fica por conta de vocês!':'🎮 Nenhum duelo confirmado ainda. Bora estrear esse confronto!')+'\nSomente partidas confirmadas neste bot; correções aplicadas e Copas canceladas excluídas.');
  } else if (cmd === '!novacopa') {
    needAdmin(); requireThat(!active(), 'Já existe Copa ativa.');
    const draft = s.drafts[event.groupId];
    requireThat(!draft || draft.expiresAt <= event.at, 'Escolha de formato já está em andamento.');
    s.drafts[event.groupId] = { ownerId: event.userId, expiresAt: event.at + 300_000 };
    notices.push(`🏆 ${competitionName.toUpperCase()} · NOVA EDIÇÃO\n${group.formatSize?`Chave configurada no painel: ${group.formatSize} vagas. Envie !formato ${group.formatSize}.`:'Escolha o tamanho da chave: 4, 8, 16 ou 32 vagas. Envie !formato 4, 8, 16 ou 32.'}\n⏳ Escolha válida por 5 minutos.`);
  } else if (/^[1234]$/.test(cmd)) {
    needAdmin(); const draft = s.drafts[event.groupId];
    requireThat(draft && draft.expiresAt > event.at, 'Escolha de formato expirada. Use !novacopa.');
    requireThat(draft.ownerId === event.userId, 'Somente o criador escolhe o formato.');
    requireThat(!active(), 'Já existe Copa ativa.');
    const size = [4, 8, 16, 32][Number(cmd) - 1]!;
    requireThat(!group.formatSize||size===group.formatSize,`Este grupo usa ${group.formatSize} vagas. Envie !formato ${group.formatSize}.`);
    const available = [...new Set(group.clubs.map(c => c.trim()).filter(Boolean))];
    requireThat(available.length >= size, 'Não há clubes suficientes no pool.');
    const id = env.id();
    requireThat(id && !Object.hasOwn(s.cups, id) && id !== '__proto__', 'ID de Copa inválido ou repetido.');
    const cup: Cup = { id, groupId: event.groupId, createdBy: event.userId, createdAt: event.at, size, competitionName, teamKind, status: 'open', participants: [], matches: [] };
    s.cups[id] = cup; delete s.drafts[event.groupId];
    audit('create', cup, 'null');
    notices.push(`🏆 ${competitionName.toUpperCase()} · ${cupLabel(cup)}\n📣 Inscrições abertas · 0/${size} vagas\n⚔️ Formato: ${roundName(size)}\n\nQuer disputar? Mande !entrar. Sorteio de ${teamPlural} e chaveamento saem quando a lista fechar.\n${openingCheers[variation%openingCheers.length]}`);
  } else if (cmd === '!entrar') {
    const cup = active(); requireThat(cup?.status === 'open', 'Nenhuma Copa com inscrições abertas.');
    requireThat(!cup.participants.some(p => p.userId === event.userId), 'Você já está inscrito nesta Copa.');
    requireThat(cup.participants.length < cup.size, 'Inscrições encerradas.');
    const before = JSON.stringify(cup);
    cup.participants.push({ userId: event.userId, name: profiles[event.userId]??cleanName(event.name) });
    notices.push(`✅ INSCRIÇÃO CONFIRMADA · ${cupLabel(cup)}\n${profiles[event.userId]??cleanName(event.name)} está na disputa!\n👥 ${cup.participants.length}/${cup.size} vagas preenchidas\n${cheer}`);
    if (cup.participants.length === cup.size) {
      const pool = [...new Set(group.clubs.map(c => c.trim()).filter(Boolean))];
      requireThat(pool.length >= cup.size, 'Não há clubes suficientes no pool.');
      const selected = env.shuffle(pool).slice(0, cup.size);
      requireThat(selected.length === cup.size && new Set(selected).size === cup.size && selected.every(c => pool.includes(c)), 'Sorteio de clubes inválido.');
      cup.participants.forEach((p, i) => { p.club = selected[i]!; });
      const ids = env.shuffle(cup.participants.map(p => p.userId));
      requireThat(ids.length === cup.size && new Set(ids).size === cup.size && ids.every(id => cup.participants.some(p => p.userId === id)), 'Sorteio de participantes inválido.');
      cup.status = 'playing';
      notices.push(`🎲 SORTEIO · ${cup.competitionName?.toUpperCase()??'MLG'}\n🏆 ${cupLabel(cup)} · ${cup.size} participantes\n\n${teamKind==='seleção'?'Seleções':'Equipes'} e adversários aparecem juntos nos jogos a seguir. O sorteio desta edição foi salvo no banco. Boa Copa!`);
      notices.push(addRound(s, cup, ids, 0));
    }
    audit('join', cup, before);
  } else if (cmd === '!sair') {
    requireThat(parts.length===1,'Use !sair sem argumentos.');
    const cup=active();requireThat(cup,'Nenhuma Copa ativa.');
    requireThat(cup.participants.some(p=>p.userId===event.userId),'Você não está inscrito nesta Copa.');
    const before=JSON.stringify(cup);
    if(cup.status==='open'){
      cup.participants=cup.participants.filter(p=>p.userId!==event.userId);
      notices.push(`👋 Inscrição retirada! Vaga liberada.\n👥 ${cup.participants.length}/${cup.size} inscritos.\nSe mudar de ideia antes do sorteio, use !entrar.`);
    }else{
      const games=cup.matches.filter(m=>[m.home,m.away].includes(event.userId)&&m.status!=='confirmed');
      requireThat(games.length===1,'Você não tem partida aberta; aguarde a próxima fase ou consulte !copa.');
      const match=games[0]!;requireThat(match.status==='scheduled','Já existe resultado ou contestação. Peça ao ADM para resolver antes de sair.');
      const home=match.home===event.userId?0:3,away=match.away===event.userId?0:3;
      match.results.push({home,away,author:event.userId,at:event.at,status:'pending',reason:'Desistência voluntária: proposta de W.O. 3x0'});match.status='pending';
      notices.push(`🏳️ W.O. PROPOSTO · PARTIDA #${match.code}\n${player(cup,match.home).name} ${home} x ${away} ${player(cup,match.away).name}\nAinda não há classificado. Qualquer jogador da dupla pode confirmar: !confirmar ${home}x${away}\nSe houver erro, use !contestar ${match.code} antes da confirmação.`);
    }
    audit('withdraw',cup,before);
  } else if (['!resultado', '!confirmar', '!contestar', '!resolver'].includes(cmd)) {
    const confirmationScore=cmd==='!confirmar'&&parts.length===2&&/^\d+x\d+$/i.test(parts[1]!);
    const shorthand=confirmationScore||(cmd==='!resultado'&&parts.length===2&&/^\d+x\d+$/.test(parts[1]!))||(['!confirmar','!contestar'].includes(cmd)&&parts.length===1);
    let inferred: {cup:Cup;match:Match}|undefined;
    if(shorthand){
      let candidates=Object.values(s.cups).filter(c=>c.groupId===event.groupId&&c.status==='playing').flatMap(c=>c.matches.filter(m=>m.status===(cmd==='!resultado'?'scheduled':'pending')&&([m.home,m.away].includes(event.userId)||(admin&&cmd!=='!resultado'))).map(match=>({cup:c,match})));
      if(cmd==='!confirmar'){const own=candidates.filter(({match:m})=>[m.home,m.away].includes(event.userId));if(own.length)candidates=own;}
      requireThat(candidates.length>0,cmd==='!confirmar'?'Nenhuma partida sua pendente. Para confirmar seu jogo, use !confirmar código.':'Nenhuma partida disponível para este comando.');
      requireThat(candidates.length===1,'Informe o código: há mais de uma partida possível. Use !copa.');
      inferred=candidates[0];
    }
    const { cup, match } = inferred??getMatch(parts[1]);
    requireThat(cup.status === 'playing', 'Copa não está em andamento.');
    const participant = [match.home, match.away].includes(event.userId);
    requireThat(admin || participant, 'Somente jogadores do confronto ou ADM.');
    const before = JSON.stringify(cup);
    if (cmd === '!resultado') {
      requireThat(match.status === 'scheduled', 'Partida já possui resultado; use o fluxo de contestação.');
      requireThat(participant, 'Somente jogadores do confronto podem registrar resultado.');
      requireThat(shorthand || parts.length === 3, 'Formato: !resultado 3x2 ou !resultado código 3x2');
      const result: Result = { ...parseScore(parts[shorthand?1:2]), author: event.userId, at: event.at, status: 'pending' };
      match.results.push(result); match.status = 'pending';
      notices.push(`📝 RESULTADO ANOTADO\nPartida #${match.code}\n${player(cup, match.home).name} ${result.home} x ${result.away} ${player(cup, match.away).name}\nClassificado provisório: ${player(cup, result.home > result.away ? match.home : match.away).name}\nAguardando confirmação de um dos dois jogadores: !confirmar ${result.home}x${result.away}.\nConfira o print no grupo; se discordar, use !contestar ${match.code} antes da confirmação.\n${pendingCheers[match.code%pendingCheers.length]}`);
    } else if (cmd === '!contestar') {
      requireThat(match.status === 'pending', 'Nenhum resultado pendente para contestar.');
      match.status = 'disputed'; score(match).status = 'disputed'; score(match).disputedBy = event.userId;
      notices.push(`⚠️ Partida #${match.code} contestada. Aguardando resolução de ADM distinto do proponente.`);
    } else if (cmd === '!resolver') {
      needAdmin(); requireThat(match.status === 'disputed', 'Resultado não está contestado.');
      requireThat(score(match).author !== event.userId, 'Não é permitido resolver o próprio resultado.');
      const reason = parts.slice(3).join(' ');
      requireThat(reason.length >= 8, 'Informe motivo com pelo menos 8 caracteres.');
      match.results.push({ ...parseScore(parts[2]), author: event.userId, at: event.at, status: 'confirmed', confirmedBy: event.userId, reason });
      notices.push(...advance(s, cup, match, event.at));
    } else {
      requireThat(match.status !== 'disputed', 'Resultado contestado; ADM deve resolver.');
      requireThat(match.status === 'pending', 'Nenhum resultado pendente.');
      const pendingResult=score(match);
      const selfConfirm=pendingResult.author===event.userId;
      requireThat(shorthand||parts.length===2||parts.length===3,'Formato: !confirmar código [placar]');
      if(confirmationScore||parts.length===3){const provided=parseScore(parts[confirmationScore?1:2]);requireThat(provided.home===pendingResult.home&&provided.away===pendingResult.away,'Placar diferente do informado. Confira mandante x visitante ou use !contestar.');}
      pendingResult.status = 'confirmed'; pendingResult.confirmedBy = event.userId;
      if(selfConfirm)pendingResult.reason=[pendingResult.reason,'Placar confirmado pelo próprio jogador que informou; sujeito a correção administrativa'].filter(Boolean).join('; ');
      if(selfConfirm)notices.push('✅ Jogador confirmou o placar que informou. Se vocês encontrarem um erro no print, um ADM pode corrigir o resultado.');
      notices.push(...advance(s, cup, match, event.at));
    }
    audit(cmd.slice(1), cup, before, match.code);
  } else if (cmd === '!forcarresultado') {
    needAdmin();
    const {cup,match}=getMatch(parts[1]);
    requireThat(cup.status!=='cancelled','Copa cancelada não pode ser corrigida.');
    const corrected=parseScore(parts[2]);
    requireThat(parts.length>=3,'Formato: !forcarresultado código 4x3 motivo opcional');
    const winner=corrected.home>corrected.away?match.home:match.away;
    const before=JSON.stringify(cup);
    if(match.status==='confirmed'){
      if(winner!==match.winner){
        const next=cup.matches.find(m=>m.round===match.round+1&&m.position===Math.floor(match.position/2));
        requireThat(!next||next.status==='scheduled','Não é possível trocar o classificado: a próxima partida já tem resultado. Resolva a sequência antes.');
        if(next){if(match.position%2===0)next.home=winner;else next.away=winner;}
      }
      match.results.push({...corrected,author:event.userId,at:event.at,status:'confirmed',confirmedBy:event.userId,reason:parts.slice(3).join(' ')||'Correção administrativa explícita'});
      match.winner=winner;
      if(match.round===Math.log2(cup.size)-1){cup.champion=winner;cup.completedAt=event.at;}
      notices.push('🛠️ RESULTADO CORRIGIDO PELO ADM\n'+describe(cup,match)+'\n✅ '+corrected.home+' x '+corrected.away+'\n📊 Estatísticas e títulos passam a refletir esta correção.');
    }else{
      match.results.push({...corrected,author:event.userId,at:event.at,status:'confirmed',confirmedBy:event.userId,reason:parts.slice(3).join(' ')||'Resultado imposto por ADM autorizado'});
      notices.push('🛠️ ADM confirmou o placar por intervenção administrativa.');
      notices.push(...advance(s,cup,match,event.at));
    }
    audit('force-result',cup,before,match.code);
  } else if (cmd === '!deletar' || cmd === '!deletartitulo') {
    needAdmin();
    requireThat(parts.length===2,'Formato: !deletar código ou !deletar título código-da-final');
    const {cup,match}=getMatch(parts[1]);
    requireThat(cup.status!=='cancelled','Copa cancelada já está fora das estatísticas.');
    requireThat(match.status!=='scheduled','A partida não possui resultado válido para anular.');
    const final=match.round===Math.log2(cup.size)-1;
    if(cmd==='!deletartitulo') requireThat(final&&cup.status==='completed','Informe o código da final de uma Copa concluída.');
    requireThat(!cup.matches.some(m=>m.round>match.round),'Anule primeiro a Copa de teste com !anularcopa número-da-edição; esta partida já gerou outra fase.');
    requireThat(!active()||active()!.id===cup.id,'Existe outra Copa ativa. Finalize ou cancele essa Copa antes de reabrir a anterior.');
    const before=JSON.stringify(cup);
    match.status='scheduled';delete match.winner;
    delete cup.champion;delete cup.completedAt;cup.status='playing';
    audit('void-result',cup,before,match.code);
    notices.push(`🧹 Resultado #${match.code} anulado pelo ADM.\n📊 Placar e eventual título retirados das estatísticas.\n🎮 Partida reaberta para um novo !resultado. Auditoria preservada.`);
  } else if (cmd === '!anularcopa') {
    needAdmin();const cup=resolveCup(parts[1]);
    requireThat(cup&&cup.groupId===event.groupId,'Copa não encontrada neste grupo. Consulte !historico.');
    requireThat(parts.length===2,'Formato: !anularcopa número-da-edição (consulte !historico)');
    requireThat(cup.status!=='cancelled','Copa já anulada.');
    const before=JSON.stringify(cup);cup.status='cancelled';cup.cancellationReason='Remoção administrativa de Copa de teste';delete cup.champion;delete cup.completedAt;
    audit('void-cup',cup,before);
    notices.push(`🧹 ${cupLabel(cup)} anulada pelo ADM.\nJogos e títulos deixam de contar nas estatísticas; o histórico permanece para consulta.`);
  } else if (cmd === '!cancelarcopa') {
    needAdmin();const cup=active();
    if(cup){const before=JSON.stringify(cup);cup.status='cancelled';cup.cancellationReason='Cancelamento explícito pelo ADM';audit('cancel',cup,before);}
    else requireThat(s.drafts[event.groupId],'Nenhuma Copa ativa.');
    delete s.drafts[event.groupId];
    notices.push(cup?`🚫 ${cupLabel(cup)} cancelada pelo ADM.\nA Copa sai da disputa; o histórico fica guardado. Para abrir outra: !novacopa.`:'🚫 Preparação da Copa cancelada. Quando a turma estiver pronta: !novacopa.');
  } else if (cmd === '!cancelar') {
    needAdmin(); requireThat(parts.slice(1).join(' ').length >= 8, 'Informe um motivo para cancelar.');
    const cup = active(); requireThat(cup, 'Nenhuma Copa ativa.');
    const before = JSON.stringify(cup); cup.status = 'cancelled'; cup.cancellationReason = parts.slice(1).join(' ');
    audit('cancel', cup, before); notices.push(`🚫 ${cupLabel(cup)} cancelada pelo ADM.\nMotivo: ${cup.cancellationReason}\nHistórico preservado; esta edição não conta nas estatísticas.`);
  } else if (cmd === '!ajuda' || cmd === '!minicamp') {
    const cup=active();
    const next=cup?.status==='open'?`Inscrições abertas: ${cup.participants.length}/${cup.size}. Use !entrar para participar.`:cup?.status==='playing'?`Copa em andamento: use !copa para ver os confrontos e !jogo código para conferir sua partida.`:admin?'Nenhuma Copa ativa. Para abrir uma, use !novacopa.':'Nenhuma Copa ativa. Aguarde um ADM abrir a próxima edição.';
    notices.push('📍 AGORA\n'+next+'\n\n'+'🏆 '+competitionName.toUpperCase()+'\nADM: !novacopa → !formato 4, 8, 16 ou 32\nJogadores: !entrar\nPlacar: !resultado 3x2 (mandante x visitante)\nMandem o print no grupo; ambos podem usar !confirmar\nDiscordou antes da confirmação: !contestar código\nADM distinto do proponente: !resolver código 3x2 motivo\nConsultas: !copa, !jogo código, !stats, !ranking, !campeoes, !historico, !minhascopas\n!stats Nome completo consulta alguém; nomes repetidos: cada jogador consulta sua conta com !stats.\nADM: !cancelar copa • !forcarresultado código 4x3 • !config\nTimes sorteados valem só para esta Copa.');
  } else if (cmd === '!titulo' || cmd === '!título') {
    const cups=Object.values(s.cups).filter(c=>c.groupId===event.groupId);
    const normalize=(v:string)=>v.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
    const names=new Map<string,string>();for(const c of cups)for(const p of c.participants)names.set(p.userId,p.name);
    const search=normalize(parts.slice(1).join(' '));
    const exact=[...names].filter(([,n])=>normalize(n)===search);
    const candidates=search?(exact.length?exact:[...names].filter(([,n])=>normalize(n).split(' ')[0]===search)):[[event.userId,names.get(event.userId)??cleanName(event.name)]];
    requireThat(candidates.length>0,'Nome não encontrado nas Copas deste grupo. Use o nome registrado na inscrição ou !titulo para consultar sua conta.');
    requireThat(candidates.length===1,'Há mais de uma pessoa com esse nome. Use o nome completo ou !titulo para consultar sua conta.');
    const [target,name]=candidates[0]!;
    const won=cups.filter(c=>c.status==='completed'&&c.champion===target).sort((a,b)=>(b.completedAt??0)-(a.completedAt??0));
    const variation=[...event.id].reduce((n,c)=>n+c.charCodeAt(0),0)%4;
    const lines=won.map(c=>`🏆 ${c.competitionName??"Minicamp MLG"} · ${cupLabel(c)} · ${cupDate(c)} · ${player(c,target!).club}`);
    const cheers=won.length?['👑 A taça está registrada. Agora aguenta a resenha!','🏆 Tem história na estante! Quem vai buscar a próxima?','🍿 Os números estão aí. O debate do grupo está liberado!','🎮 Conquista confirmada. Bora defender essa moral na próxima Copa!']:['😄 A estante está esperando a estreia. Bora de !entrar na próxima!','🍿 Sem taça por enquanto, mas presença na resenha está garantida!','🎮 O primeiro título ainda está em jogo. Próxima Copa, nova chance!','🏆 Ainda não levantou uma aqui. A próxima história pode ser sua!'];
    notices.push(`🏆 TÍTULOS DO MINICAMP\n${name}\nTotal neste grupo: ${won.length}\n${lines.join('\n')}\n${cheers[variation]}\nSomente Copas concluídas neste bot; edições anuladas não contam.`);
  } else if (cmd === '!stats') {
    const cups = Object.values(s.cups).filter(c=>c.groupId===event.groupId&&c.status!=='cancelled');
    const search=parts.slice(1).join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const named=new Map<string,string>();for(const c of cups)for(const p of c.participants)named.set(p.userId,p.name);for(const [id,n] of Object.entries(profiles))named.set(id,n);
    const candidates=search?[...named].filter(([,name])=>name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()===search).map(([id])=>id):[event.userId];
    requireThat(candidates.length===1,'Nome não encontrado ou ambíguo. Cada jogador pode consultar a própria conta com !stats.');
    const target=candidates[0]!;let wins=0,losses=0,gf=0,ga=0,titles=0,runnerUp=0,streak=0,record=0;
    const played=cups.flatMap(c=>c.matches.filter(m=>m.status==='confirmed'&&[m.home,m.away].includes(target))).sort((a,b)=>a.results[0]!.at-b.results[0]!.at||a.code-b.code);
    for(const m of played){const r=score(m);const home=m.home===target;gf+=home?r.home:r.away;ga+=home?r.away:r.home;if(m.winner===target){wins++;streak++;record=Math.max(record,streak);}else{losses++;streak=0;}}
    for(const c of cups.filter(c=>c.status==='completed')){titles+=Number(c.champion===target);const final=c.matches.find(m=>m.round===Math.log2(c.size)-1);if(final&&[final.home,final.away].includes(target)&&c.champion!==target)runnerUp++;}
    notices.push(`👤 ESTATÍSTICAS DO TREINADOR\n${named.get(target)??cleanName(event.name)}\n🏆 Títulos: ${titles}\n🥈 Vices: ${runnerUp}\n🎮 Jogos: ${played.length}\n✅ Vitórias: ${wins}\n❌ Derrotas: ${losses}\n⚽ Gols pró: ${gf}\n🥅 Gols contra: ${ga}\n🔥 Vitórias seguidas: ${streak}\n🏅 Recorde: ${record}\nSomente partidas confirmadas neste bot; Copas canceladas não contam.`);
  } else if (cmd === '!sorteio') {
    requireThat(parts.length===1,'Use !sorteio sem argumentos.');
    const cup=active();requireThat(cup?.status==='playing','Aguarde o fechamento das inscrições para conferir o sorteio.');
    const matches=cup.matches.filter(m=>m.round===0).sort((a,b)=>a.position-b.position);
    notices.push(`🎲 SORTEIO · ${cup.competitionName?.toUpperCase()??'MLG'}\n🏆 ${cupLabel(cup)} · ${cup.size} participantes\n\n${matches.map(m=>`🔹 LADO ${m.position<cup.size/4?'A':'B'}\n${matchCard(cup,m,matchStatus(m.status))}`).join('\n\n')}\n\n📌 Primeiro nome: mandante. Use !chave para ver o caminho até a final.`);
  } else if (cmd === '!chave' || cmd === '!lado') {
    const arg=parts[1]?.toUpperCase();
    requireThat(parts.length<=2 && (!arg || arg==='A' || arg==='B'), 'Use !chave, !chave A ou !chave B.');
    const cup=active();requireThat(cup, 'Nenhuma Copa ativa neste grupo.');
    notices.push(`🗺️ CAMINHO ATÉ A TAÇA · ${cup.competitionName?.toUpperCase()??'MLG'}\n🏆 ${cupLabel(cup)} · ${cupStatus(cup)}\n\n${bracket(cup,arg as 'A'|'B'|undefined)}\n\n📌 Cada lado classifica um finalista. Um resultado só avança após confirmação.`);
  } else if (cmd === '!jogo') {
    const { cup, match } = getMatch(parts[1]);
    const result = match.status==='scheduled'?undefined:match.results.at(-1);
    notices.push(`${describe(cup, match)}\nSituação: ${matchStatus(match.status)}${result ? `\nPlacar: ${result.home}x${result.away}` : '\nSem placar'}`);
  } else if (['!copa', '!historico', '!minhascopas', '!campeoes', '!ranking'].includes(cmd)) {
    const cups = Object.values(s.cups).filter(c => c.groupId === event.groupId).sort((a, b) => b.createdAt - a.createdAt);
    if (cmd === '!copa') {
      const cup = active() ?? cups[0];
      notices.push(cup ? `🏆 ${cup.competitionName?.toUpperCase()??"MINICAMP MLG"} · ${cupLabel(cup)}\n${cupStatus(cup)} · ${cup.participants.length}/${cup.size} inscritos\n\n${bracket(cup)}\n\n🔎 Veja um lado por vez: !chave A ou !chave B.` : 'Nenhuma Copa neste grupo.');
    } else if (cmd === '!ranking') {
      const rows = new Map<string, { id: string; name: string; titles: number; wins: number }>();
      for (const cup of cups.filter(c => c.status !== 'cancelled')) {
        for (const p of cup.participants) {
          const row = rows.get(p.userId) ?? { id: p.userId, name: p.name, titles: 0, wins: 0 };
          row.titles += Number(cup.champion === p.userId);
          row.wins += cup.matches.filter(m => m.winner === p.userId).length;
          rows.set(p.userId, row);
        }
      }
      const ranked=[...rows.values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || a.id.localeCompare(b.id));
      const page=pageOf(parts[1],ranked.length,cmd);const total=Math.max(1,Math.ceil(ranked.length/6));
      notices.push(`🏆 RANKING · ${page}/${total}\n`+(ranked.slice((page-1)*6,page*6).map((p,i)=>`${(page-1)*6+i+1}. ${p.name}\n🏆 ${p.titles} ${p.titles===1?'título':'títulos'} · ✅ ${p.wins} ${p.wins===1?'vitória':'vitórias'}`).join('\n\n')||'Nenhum participante registrado.')+(page<total?`\n\nPróxima página: ${cmd} ${page+1}`:''));
    } else {
      const selected = cups.filter(c => cmd === '!campeoes' ? c.status === 'completed' : cmd !== '!minhascopas' || c.participants.some(p => p.userId === event.userId));
      const page=pageOf(parts[1],selected.length,cmd);const total=Math.max(1,Math.ceil(selected.length/6));
      const heading=cmd==='!campeoes'?'👑 GALERIA DOS CAMPEÕES':cmd==='!minhascopas'?`🎮 MINHAS COPAS · ${competitionName.toUpperCase()}`:`📚 HISTÓRICO · ${competitionName.toUpperCase()}`;
      const lines=selected.slice((page-1)*6,page*6).map(c=>`🏆 ${c.competitionName??"Minicamp MLG"} · ${cupLabel(c)} · ${cupDate(c)}\n${c.champion?`👑 ${profiles[c.champion]??player(c,c.champion).name} · ${player(c,c.champion).club}`:cupStatus(c)} · ${c.participants.length}/${c.size} inscritos`);
      const cheers=['🍿 O próximo capítulo é no controle!','🎮 Cada taça tem sua história. Quem leva a próxima?','🔥 A galeria cresce a cada edição confirmada.','🏟️ História registrada. Agora é preparar a próxima!'];
      notices.push(`${heading} · ${page}/${total}\n${lines.join('\n\n')||'Nenhum registro por aqui ainda.'}${lines.length&&cmd==='!campeoes'?`\n\n${cheers[variation%cheers.length]}`:''}${page<total?`\n\nPróxima página: ${cmd} ${page+1}`:''}`);
    }
  } else {
    throw new Error('Comando desconhecido.');
  }
  s.processed[eventKey] = true;
  return { state: s, notices };
}
