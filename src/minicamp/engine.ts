import { randomInt, randomUUID } from 'node:crypto';

// Pure domain boundary. The production adapter MUST resolve identities, load
// permissions and commit state + inbox + audit + outbox in one DB transaction.
// This module does not provide a database, transport or operational durability.
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
  size: number; status: 'open' | 'playing' | 'completed' | 'cancelled';
  participants: Participant[]; matches: Match[]; champion?: string; completedAt?: number; cancellationReason?: string;
};
type Audit = {
  actor: string; groupId: string; cupId: string; matchCode?: number; at: number;
  action: string; before: string; after: string; outcome: 'accepted';
};
export type State = {
  groups: Record<string, { authorized: boolean; admins: string[]; clubs: string[] }>;
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
  return ({ 2: 'FINAL', 4: 'SEMIFINAL', 8: 'QUARTAS DE FINAL', 16: 'OITAVAS DE FINAL' } as Record<number, string>)[count] ?? `RODADA ${count}`;
}
function player(cup: Cup, id: string): Participant {
  const value = cup.participants.find(p => p.userId === id);
  requireThat(value, 'Participante não encontrado.');
  return value;
}
function describe(cup: Cup, m: Match): string {
  const home = player(cup, m.home), away = player(cup, m.away);
  return `#${m.code}\n${home.name} — ${home.club}\n🆚\n${away.name} — ${away.club}`;
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
  const output: string[] = [`⚔️ ${roundName(ids.length)}`];
  for (let i = 0; i < ids.length; i += 2) {
    requireThat(Number.isSafeInteger(s.nextCode) && s.nextCode < Number.MAX_SAFE_INTEGER, 'Limite de códigos atingido.');
    const match: Match = { code: s.nextCode++, round, position: i / 2, home: ids[i]!, away: ids[i + 1]!, status: 'scheduled', results: [] };
    cup.matches.push(match);
    output.push(describe(cup, match));
  }
  return output.join('\n\n');
}
function advance(s: State, cup: Cup, match: Match, at: number): string[] {
  const r = score(match);
  match.winner = r.home > r.away ? match.home : match.away;
  match.status = 'confirmed';
  const winner = player(cup, match.winner);
  const loser = player(cup, match.winner === match.home ? match.away : match.home);
  const notices = [`✅ RESULTADO CONFIRMADO\n#${match.code}\n${player(cup, match.home).name} ${r.home} x ${r.away} ${player(cup, match.away).name}\n🏆 ${winner.name} está classificado!\n${loser.name} está eliminado.`];
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
    notices.push(`🏆 MINICAMP — CAMPEÃO 🏆\n${winner.name.toUpperCase()}\n🎮 Clube: ${winner.club}\nCAMPEÃO DA EDIÇÃO!\n\nCAMPANHA:\n${campaign.join('\n')}`);
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
  const normalized = event.text.trim().replace(/^!formato\s+(4|8|16)$/i, (_, n) => (({ '4':'1','8':'2','16':'3' } as Record<string,string>)[n]!));
  const parts = normalized.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  let notices: string[] = [];
  if (cmd === '!novacopa') {
    needAdmin(); requireThat(!active(), 'Já existe Copa ativa.');
    const draft = s.drafts[event.groupId];
    requireThat(!draft || draft.expiresAt <= event.at, 'Escolha de formato já está em andamento.');
    s.drafts[event.groupId] = { ownerId: event.userId, expiresAt: event.at + 300_000 };
    notices.push('🏆 MINICAMP\nEscolha:\n1 — Semifinal (4)\n2 — Quartas (8)\n3 — Oitavas (16)');
  } else if (/^[123]$/.test(cmd)) {
    needAdmin(); const draft = s.drafts[event.groupId];
    requireThat(draft && draft.expiresAt > event.at, 'Escolha de formato expirada. Use !novacopa.');
    requireThat(draft.ownerId === event.userId, 'Somente o criador escolhe o formato.');
    requireThat(!active(), 'Já existe Copa ativa.');
    const size = [4, 8, 16][Number(cmd) - 1]!;
    const available = [...new Set(group.clubs.map(c => c.trim()).filter(Boolean))];
    requireThat(available.length >= size, 'Não há clubes suficientes no pool.');
    const id = env.id();
    requireThat(id && !Object.hasOwn(s.cups, id) && id !== '__proto__', 'ID de Copa inválido ou repetido.');
    const cup: Cup = { id, groupId: event.groupId, createdBy: event.userId, createdAt: event.at, size, status: 'open', participants: [], matches: [] };
    s.cups[id] = cup; delete s.drafts[event.groupId];
    audit('create', cup, 'null');
    notices.push(`🏆 MINICAMP MLG\nNova Copa criada!\nFormato: ${roundName(size)}\n👥 Vagas: 0/${size}\nInscrições abertas.\nPara participar: !entrar`);
  } else if (cmd === '!entrar') {
    const cup = active(); requireThat(cup?.status === 'open', 'Nenhuma Copa com inscrições abertas.');
    requireThat(!cup.participants.some(p => p.userId === event.userId), 'Você já está inscrito nesta Copa.');
    requireThat(cup.participants.length < cup.size, 'Inscrições encerradas.');
    const before = JSON.stringify(cup);
    cup.participants.push({ userId: event.userId, name: cleanName(event.name) });
    notices.push(`✅ ENTRADA APROVADA\n${cleanName(event.name)} entrou no Minicamp!\n👥 Participantes: ${cup.participants.length}/${cup.size}`);
    if (cup.participants.length === cup.size) {
      const pool = [...new Set(group.clubs.map(c => c.trim()).filter(Boolean))];
      requireThat(pool.length >= cup.size, 'Não há clubes suficientes no pool.');
      const selected = env.shuffle(pool).slice(0, cup.size);
      requireThat(selected.length === cup.size && new Set(selected).size === cup.size && selected.every(c => pool.includes(c)), 'Sorteio de clubes inválido.');
      cup.participants.forEach((p, i) => { p.club = selected[i]!; });
      const ids = env.shuffle(cup.participants.map(p => p.userId));
      requireThat(ids.length === cup.size && new Set(ids).size === cup.size && ids.every(id => cup.participants.some(p => p.userId === id)), 'Sorteio de participantes inválido.');
      cup.status = 'playing';
      notices.push(`🔒 INSCRIÇÕES ENCERRADAS\n${cup.size}/${cup.size}\n🎲 CLUBES SORTEADOS\n${cup.participants.map(p => `${p.name} — ${p.club}`).join('\n')}`);
      notices.push(addRound(s, cup, ids, 0));
    }
    audit('join', cup, before);
  } else if (['!resultado', '!confirmar', '!contestar', '!resolver'].includes(cmd)) {
    const { cup, match } = getMatch(parts[1]);
    requireThat(cup.status === 'playing', 'Copa não está em andamento.');
    const participant = [match.home, match.away].includes(event.userId);
    requireThat(admin || participant, 'Somente jogadores do confronto ou ADM.');
    const before = JSON.stringify(cup);
    if (cmd === '!resultado') {
      requireThat(match.status === 'scheduled', 'Partida já possui resultado; use o fluxo de contestação.');
      requireThat(parts.length === 3, 'Formato: !resultado código 3x2');
      const result: Result = { ...parseScore(parts[2]), author: event.userId, at: event.at, status: 'pending' };
      match.results.push(result); match.status = 'pending';
      notices.push(`⚠️ CONFIRMAÇÃO DE RESULTADO\nPartida #${match.code}\n${player(cup, match.home).name} ${result.home} x ${result.away} ${player(cup, match.away).name}\nVencedor provisório: ${player(cup, result.home > result.away ? match.home : match.away).name}\nAguardando confirmação de outra pessoa autorizada.\n!confirmar ${match.code}\n!contestar ${match.code}`);
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
      requireThat(score(match).author !== event.userId, 'Não é permitido confirmar o próprio resultado.');
      score(match).status = 'confirmed'; score(match).confirmedBy = event.userId;
      notices.push(...advance(s, cup, match, event.at));
    }
    audit(cmd.slice(1), cup, before, match.code);
  } else if (cmd === '!cancelar') {
    needAdmin(); requireThat(parts.slice(1).join(' ').length >= 8, 'Informe um motivo para cancelar.');
    const cup = active(); requireThat(cup, 'Nenhuma Copa ativa.');
    const before = JSON.stringify(cup); cup.status = 'cancelled'; cup.cancellationReason = parts.slice(1).join(' ');
    audit('cancel', cup, before); notices.push('Copa cancelada. Histórico preservado.');
  } else if (cmd === '!ajuda' || cmd === '!minicamp') {
    notices.push('🏆 MINICAMP MLG\nADM: !novacopa → !formato 4, 8 ou 16\nJogadores: !entrar\nPlacar: !resultado código 3x2 (mandante x visitante)\nOutra pessoa autorizada: !confirmar código\nDiscordou: !contestar código\nADM distinto do proponente: !resolver código 3x2 motivo\nConsultas: !copa, !jogo código, !stats, !ranking, !campeoes, !historico, !minhascopas\n!stats Nome completo consulta alguém; nomes repetidos: cada jogador consulta sua conta com !stats.\nADM: !cancelar motivo\nClubes sorteados valem só para esta Copa.');
  } else if (cmd === '!stats') {
    const cups = Object.values(s.cups).filter(c=>c.groupId===event.groupId&&c.status!=='cancelled');
    const search=parts.slice(1).join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const named=new Map<string,string>();for(const c of cups)for(const p of c.participants)named.set(p.userId,p.name);
    const candidates=search?[...named].filter(([,name])=>name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()===search).map(([id])=>id):[event.userId];
    requireThat(candidates.length===1,'Nome não encontrado ou ambíguo. Cada jogador pode consultar a própria conta com !stats.');
    const target=candidates[0]!;let wins=0,losses=0,gf=0,ga=0,titles=0,runnerUp=0,streak=0,record=0;
    const played=cups.flatMap(c=>c.matches.filter(m=>m.status==='confirmed'&&[m.home,m.away].includes(target))).sort((a,b)=>score(a).at-score(b).at||a.code-b.code);
    for(const m of played){const r=score(m);const home=m.home===target;gf+=home?r.home:r.away;ga+=home?r.away:r.home;if(m.winner===target){wins++;streak++;record=Math.max(record,streak);}else{losses++;streak=0;}}
    for(const c of cups.filter(c=>c.status==='completed')){titles+=Number(c.champion===target);const final=c.matches.find(m=>m.round===Math.log2(c.size)-1);if(final&&[final.home,final.away].includes(target)&&c.champion!==target)runnerUp++;}
    notices.push(`👤 ESTATÍSTICAS DO TREINADOR\n${named.get(target)??cleanName(event.name)}\n🏆 Títulos: ${titles}\n🥈 Vices: ${runnerUp}\n🎮 Jogos: ${played.length}\n✅ Vitórias: ${wins}\n❌ Derrotas: ${losses}\n⚽ Gols pró: ${gf}\n🥅 Gols contra: ${ga}\n🔥 Vitórias seguidas: ${streak}\n🏅 Recorde: ${record}\nSomente partidas confirmadas neste bot; Copas canceladas não contam.`);
  } else if (cmd === '!jogo') {
    const { cup, match } = getMatch(parts[1]);
    const result = match.results.at(-1);
    notices.push(`${describe(cup, match)}\nStatus: ${match.status}${result ? `\nPlacar: ${result.home}x${result.away}` : '\nSem placar'}`);
  } else if (['!copa', '!historico', '!minhascopas', '!campeoes', '!ranking'].includes(cmd)) {
    const cups = Object.values(s.cups).filter(c => c.groupId === event.groupId).sort((a, b) => b.createdAt - a.createdAt);
    if (cmd === '!copa') {
      const cup = active() ?? cups[0];
      notices.push(cup ? `🏆 MINICAMP ${cup.id}\n${cup.status}\n${cup.participants.length}/${cup.size}\n${cup.matches.map(m => `${describe(cup, m)}\n${m.status}`).join('\n\n')}` : 'Nenhuma Copa neste grupo.');
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
      notices.push('🏆 RANKING\n' + [...rows.values()].sort((a, b) => b.titles - a.titles || b.wins - a.wins || a.id.localeCompare(b.id)).map((p, i) => `${i + 1}. ${p.name} — ${p.titles} títulos, ${p.wins} vitórias`).join('\n'));
    } else {
      const selected = cups.filter(c => cmd === '!campeoes' ? c.status === 'completed' : cmd !== '!minhascopas' || c.participants.some(p => p.userId === event.userId));
      notices.push('🏆 MINICAMP — HISTÓRICO\n' + (selected.map(c => `${c.id} | ${c.size} participantes | ${c.status}${c.champion ? ` | Campeão: ${player(c, c.champion).name} — ${player(c, c.champion).club}` : ''}`).join('\n') || 'Nenhum registro.'));
    }
  } else {
    throw new Error('Comando desconhecido.');
  }
  s.processed[eventKey] = true;
  return { state: s, notices };
}
