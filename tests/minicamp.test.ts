import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, emptyState, environment, type State } from '../src/minicamp/engine.ts';
import {worldCupCandidates} from '../src/minicamp/nations.ts';

const clubs = Array.from({ length: 20 }, (_, i) => `Clube ${i + 1}`);
test('a chave mostra lados estáveis, classificados e caminho até a final',()=>{
 const h=harness();const cup=h.start(16);
 const first=cup.matches.filter(m=>m.round===0).sort((a,b)=>a.position-b.position);
 const overview=h.send('u0','!copa').notices[0]!;
 const a=h.send('u0','!chave A').notices[0]!;
 const b=h.send('u0','!chave B').notices[0]!;
 assert.match(overview,/LADO A[\s\S]+LADO B[\s\S]+FINAL/);
 assert.ok(a.includes(`JOGO ${first[0]!.code}`));
 assert.ok(!a.includes(`JOGO ${first[4]!.code}`));
 assert.ok(b.includes(`JOGO ${first[4]!.code}`));
 assert.ok(!b.includes(`JOGO ${first[0]!.code}`));
 assert.match(a,/Vencedor jogo/);
 assert.match(a,/FINAL · Lado A × Lado B/);
 const match=first[0]!;h.send(match.home,`!resultado ${match.code} 3x1`);
 h.send(match.home,`!confirmar ${match.code}`);
 const updated=h.send('u0','!chave A').notices[0]!;
 assert.match(updated,/Avança:/);
 assert.ok(updated.includes(match.home));
 assert.throws(()=>h.send('u0','!chave C'),/Use !chave/);
 assert.match(h.send('u0','!comandos').notices[0]!,/!chave A ou !chave B/);
});
function harness() {
  let state = emptyState();
  state.groups.g = { authorized: true, admins: ['admin', 'admin2'], clubs };
  let id = 0;
  return {
    get state() { return state; },
    send(userId: string, text: string, eventId = `e${++id}`, groupId = 'g') {
      const result = apply(state, { id: eventId, groupId, userId, name: userId, text, at: 1000 + id }, environment);
      state = result.state;
      return result;
    },
    restart() { state = JSON.parse(JSON.stringify(state)) as State; },
    start(size: number) {
      this.send('admin', '!novacopa');
      this.send('admin', String(({ 4: 1, 8: 2, 16: 3 } as Record<number, number>)[size]));
      for (let i = 0; i < size; i++) this.send(`u${i}`, '!entrar');
      return Object.values(state.cups)[0]!;
    },
  };
}

for (const size of [4, 8, 16]) {
  test(`copa completa ${size}: clubes, chaves, resultados, campanha e histórico`, () => {
    const h = harness();
    let cup = h.start(size);
    const cupId = cup.id;
    assert.equal(new Set(cup.participants.map(p => p.club)).size, size);
    assert.equal(cup.matches.length, size / 2);
    assert.equal(new Set(cup.matches.flatMap(m => [m.home, m.away])).size, size);
    while (h.state.cups[cupId]!.status !== 'completed') {
      cup = h.state.cups[cupId]!;
      const match = cup.matches.find(m => m.status === 'scheduled')!;
      h.send(match.home, `!resultado ${match.code} 3x2`);
      assert.equal(h.state.cups[cupId]!.matches.find(m => m.code === match.code)!.winner, undefined);
      h.restart();
      h.send(match.away, `!confirmar ${match.code}`);
    }
    cup = h.state.cups[cupId]!;
    assert.equal(cup.matches.length, size - 1);
    assert.equal(new Set(cup.matches.map(m => m.code)).size, size - 1);
    assert.equal(cup.matches.filter(m => m.winner === cup.champion).length, Math.log2(size));
    const gallery=h.send('u0','!campeoes').notices.join('\n');
    assert.ok(gallery.includes(cup.champion!));
    assert.match(gallery,/GALERIA DOS CAMPEÕES.*Edição 1/s);
    assert.ok(!gallery.includes(cup.id));
    h.send('admin', '!novacopa');
    h.send('admin', '1');
    assert.equal(Object.values(h.state.cups).filter(c => c.status === 'completed').length, 1);
  });
}

test('consultas exibem edições legíveis e aceitam seu número sem revelar código da Copa',()=>{
 const h=harness();const cup=h.start(4);
 for(const command of ['!copa','!historico','!participantes','!minhascopas']){
  const result=h.send('u0',command).notices[0]!;
  assert.match(result,/Edição 1/);assert.ok(!result.includes(cup.id));
 }
 assert.match(h.send('u0','!participantes 1').notices[0]!,/Edição 1/);
 assert.throws(()=>h.send('u0','!historico 2'),/Página inválida/);
 h.send('admin','!anularcopa 1');assert.equal(h.state.cups[cup.id]!.status,'cancelled');
 assert.match(h.send('u0','!historico').notices[0]!,/anulada/);
});

test('sorteio e placar orientam a dupla sem exigir confirmação do adversário',()=>{
 const h=harness();h.send('admin','!novacopa');h.send('admin','1');
 for(let i=0;i<3;i++)h.send(`u${i}`,'!entrar');
 const announced=h.send('u3','!entrar').notices;
 assert.match(announced[1]!,/SORTEIO · MINICAMP MLG.*Equipes e adversários/s);
 assert.match(announced[2]!,/SEMIFINAL · 2 jogos/);
 assert.equal((announced[2]!.match(/^🎮 JOGO \d+/gm)??[]).length,2);
 const overview=h.send('u0','!sorteio').notices[0]!;
 assert.match(overview,/SORTEIO · MINICAMP MLG/);assert.equal((overview.match(/^🎮 JOGO \d+/gm)??[]).length,2);
 assert.match(announced[2]!,/Os dois jogadores podem confirmar/);
 const match=Object.values(h.state.cups)[0]!.matches[0]!;
 const pending=h.send(match.away,`!resultado ${match.code} 0x2`).notices[0]!;
 assert.match(pending,/Aguardando confirmação de um dos dois jogadores/);
 assert.doesNotMatch(pending,/Falta a conferência do adversário|Um toque do outro lado/);
});

test('evento repetido não cria copa, inscrição ou confirmação duplicada', () => {
  const h = harness();
  h.send('admin', '!novacopa', 'same');
  assert.deepEqual(h.send('admin', '!novacopa', 'same').notices, []);
  h.send('admin', '1');
  h.send('u0', '!entrar', 'join');
  assert.deepEqual(h.send('u0', '!entrar', 'join').notices, []);
  assert.throws(() => h.send('u0', '!entrar'), /inscrito/);
  for (let i = 1; i < 4; i++) h.send(`u${i}`, '!entrar');
  const match = Object.values(h.state.cups)[0]!.matches[0]!;
  h.send(match.home, `!resultado ${match.code} 1x0`, 'score');
  assert.deepEqual(h.send(match.home, `!resultado ${match.code} 1x0`, 'score').notices, []);
  h.send(match.away, `!confirmar ${match.code}`, 'confirm');
  assert.deepEqual(h.send(match.away, `!confirmar ${match.code}`, 'confirm').notices, []);
  assert.throws(() => h.send(match.away, `!confirmar ${match.code}`), /pendente/);
});

test('permissões e validação de resultado/contestação', () => {
  const h = harness();
  assert.throws(() => h.send('u0', '!novacopa'), /ADM/);
  const m = h.start(4).matches[0]!;
  assert.throws(() => h.send('stranger', `!resultado ${m.code} 2x0`), /confronto/);
  assert.throws(() => h.send(m.home, `!resultado ${m.code} 2x2`), /empate/);
  assert.throws(() => h.send(m.home, `!resultado ${m.code} -1x2`), /Formato/);
  h.send(m.home, `!resultado ${m.code} 0x2`);
  const before = JSON.stringify(h.state);
  assert.throws(() => h.send(m.home, `!confirmar ${m.code} 2x0`), /Placar diferente/);
  assert.throws(() => h.send('stranger', `!confirmar ${m.code}`), /confronto/);
  assert.equal(JSON.stringify(h.state), before);
  h.send(m.away, `!contestar ${m.code}`);
  assert.throws(() => h.send('admin', `!confirmar ${m.code}`), /contestado/);
  assert.throws(() => h.send(m.away, `!resolver ${m.code} 1x0 motivo válido`), /ADM/);
  h.send('admin', `!resolver ${m.code} 0x1 placar conferido pelos jogadores`);
  const updated = Object.values(h.state.cups)[0]!.matches[0]!;
  assert.equal(updated.winner, m.away);
  assert.equal(updated.results.length, 2);
  assert.equal(updated.results[0]!.status, 'disputed');
});

test('vencedor confirma o placar informado imediatamente sem depender do adversário',()=>{
 const h=harness(),cup=h.start(4),match=cup.matches[0]!;
 h.send(match.home,`!resultado ${match.code} 2x0`);
 const third=cup.participants.find(p=>![match.home,match.away].includes(p.userId))!.userId;
 assert.throws(()=>h.send(third,`!confirmar ${match.code}`),/confronto/);
 assert.throws(()=>h.send('stranger',`!confirmar ${match.code}`),/confronto/);
 assert.throws(()=>h.send(match.home,`!confirmar ${match.code} 0x2`),/Placar diferente/);
 assert.equal(h.state.cups[cup.id]!.matches[0]!.status,'pending');
 h.restart();const done=h.send(match.home,`!confirmar ${match.code} 2x0`);
 assert.match(done.notices.join('\n'),/Jogador confirmou/);
 assert.equal(h.state.cups[cup.id]!.matches[0]!.winner,match.home);
 assert.equal(h.state.cups[cup.id]!.matches[0]!.results[0]!.confirmedBy,match.home);
 assert.match(h.state.cups[cup.id]!.matches[0]!.results[0]!.reason!,/próprio jogador/);
 assert.throws(()=>h.send(match.away,`!contestar ${match.code}`),/pendente/);
});

test('jogador que perdeu também pode registrar e confirmar a própria partida',()=>{
 const h=harness(),cup=h.start(4),match=cup.matches[0]!;
 h.send(match.home,`!resultado ${match.code} 0x2`);
 h.restart();h.send(match.home,`!confirmar ${match.code}`);
 const confirmed=h.state.cups[cup.id]!.matches[0]!;
 assert.equal(confirmed.status,'confirmed');
 assert.equal(confirmed.winner,match.away);
 assert.equal(confirmed.results[0]!.confirmedBy,match.home);
 assert.match(confirmed.results[0]!.reason!,/próprio jogador/);
});

test('ADM proponente não resolve sozinho uma contestação', () => {
  const h = harness();
  const m = h.start(4).matches[0]!;
  h.state.groups.g!.admins.push(m.home);
  h.send(m.home, `!resultado ${m.code} 0x2`);
  h.send(m.away, `!contestar ${m.code}`);
  assert.throws(() => h.send(m.home, `!resolver ${m.code} 2x0 conferido novamente`), /próprio/);
  h.send('admin2', `!resolver ${m.code} 2x0 conferido novamente`);
});

test('restart de contrato durante inscrição preserva estado e sorteio', () => {
  const h = harness();
  h.send('admin', '!novacopa'); h.restart(); h.send('admin', '2');
  h.send('u0', '!entrar'); h.restart();
  for (let i = 1; i < 8; i++) h.send(`u${i}`, '!entrar');
  const before = JSON.stringify(h.state);
  h.restart();
  assert.equal(JSON.stringify(h.state), before);
  assert.equal(Object.values(h.state.cups)[0]!.participants.length, 8);
});

test('isolamento entre grupos, escolha pelo criador e pool insuficiente', () => {
  const h = harness();
  h.send('admin', '!novacopa');
  assert.throws(() => h.send('admin2', '1'), /criador/);
  h.send('admin', '1');
  assert.throws(() => h.send('admin', '!novacopa'), /ativa/);
  assert.throws(() => h.send('u0', '!entrar', 'other', 'outside'), /autorizado/);
  h.state.groups.small = { authorized: true, admins: ['admin'], clubs: ['A'] };
  h.send('admin', '!novacopa', 'small1', 'small');
  assert.throws(() => h.send('admin', '1', 'small2', 'small'), /clubes/);
});

test('placar sempre mandante x visitante e queries orientadas ao grupo', () => {
  const h = harness();
  const m = h.start(4).matches[0]!;
  h.send(m.away, `!resultado ${m.code} 3x2`);
  h.send(m.home, `!confirmar ${m.code}`);
  assert.equal(Object.values(h.state.cups)[0]!.matches[0]!.winner, m.home);
  h.state.groups.other = { authorized: true, admins: ['admin'], clubs };
  assert.throws(() => h.send('admin', `!jogo ${m.code}`, 'other-event', 'other'), /encontrada/);
  assert.ok(h.send(m.home, '!minhascopas').notices[0]!.includes('MINICAMP'));
  assert.ok(h.send(m.home, '!ranking').notices[0]!.includes(m.home));
});

test('cancelamento preserva registros e exige motivo', () => {
  const h = harness(); h.start(4);
  assert.throws(() => h.send('admin', '!cancelar'), /motivo/);
  h.send('admin', '!cancelar participantes indisponíveis');
  assert.equal(Object.values(h.state.cups)[0]!.status, 'cancelled');
  assert.equal(Object.values(h.state.cups)[0]!.participants.length, 4);
  assert.ok(h.state.audit.some(a => a.action === 'cancel'));
});

test('formato command and statistics follow confirmed matches and preserve history',()=>{
 const h=harness();h.send('admin','!novacopa');h.send('admin','!formato 4');
 for(let i=0;i<4;i++)h.send(`u${i}`,'!entrar');
 const id=Object.keys(h.state.cups)[0]!;
 while(h.state.cups[id]!.status!=='completed'){
  const m=h.state.cups[id]!.matches.find(m=>m.status==='scheduled')!;
  h.send(m.home,`!resultado ${m.code} 3x1`);
  const before=h.send(m.home,'!stats').notices[0]!;assert.ok(before.includes('ESTATÍSTICAS'));
  h.send(m.away,`!confirmar ${m.code}`);
 }
 const champion=h.state.cups[id]!.champion!;
 const stats=h.send(champion,'!stats').notices[0]!;
 assert.match(stats,/Títulos: 1/);assert.match(stats,/Vitórias: 2/);assert.match(stats,/Gols pró: 6/);assert.match(stats,/Gols contra: 2/);
 assert.match(h.send('admin',`!stats ${champion}`).notices[0]!,/Títulos: 1/);
 assert.throws(()=>h.send('admin','!titulo qualquer pessoa'),/não encontrado/);
});

test('placar sem código, visitante, confirmação e ambiguidade de ADM', () => {
 const h=harness();const cup=h.start(4),[a,b]=cup.matches;
 assert.throws(()=>h.send('admin',`!resultado ${a!.code} 4x3`),/jogadores/);
 h.send(a!.away,'!resultado 4 x 3');
 assert.throws(()=>h.send(a!.away,'!confirmar 3x4'),/Placar diferente/);
 h.send(b!.home,'!resultado 2x1');
 assert.throws(()=>h.send('admin','!confirmar'),/código/);
 h.send(a!.home,'!confirmar');
 assert.equal(h.state.cups[cup.id]!.matches[0]!.winner,a!.home);
 h.send('admin','!confirmar');
 assert.equal(h.state.cups[cup.id]!.matches[1]!.winner,b!.home);
 assert.throws(()=>h.send('stranger','!resultado 1x0'),/partida/);
});

test('ADM corrige estatísticas sem duplicar título e cancela rascunho',()=>{
 const h=harness();h.send('admin','!novacopa');h.send('admin','!cancelar copa');
 const c=h.start(4),a=c.matches[0]!,b=c.matches[1]!;
 assert.throws(()=>h.send(a.home,`!forcarresultado ${a.code} 4x3`),/ADM/);
 h.send('admin',`!forcarresultado ${a.code} 4x3`);
 h.send('admin',`!forcarresultado ${b.code} 2x1`);
 h.send('admin',`!forcarresultado ${a.code} 0x1`);
 let final=h.state.cups[c.id]!.matches.at(-1)!;
 assert.equal(final.home,a.away);
 h.send(final.home,'!resultado 3x1');h.send(final.away,'!confirmar');
 assert.throws(()=>h.send('admin',`!forcarresultado ${a.code} 2x0`),/próxima/);
 h.send('admin',`!forcarresultado ${final.code} 0x2`);
 assert.equal(h.state.cups[c.id]!.champion,final.away);
 assert.match(h.send(final.away,'!stats').notices[0]!,/Títulos: 1/);
 assert.match(h.send(final.home,'!stats').notices[0]!,/Títulos: 0/);
});

test('comandos públicos e confronto contam só resultados confirmados e corrigidos',()=>{
 const h=harness();assert.match(h.send('visitante','!comandos').notices[0]!,/!confronto/);
 const cup=h.start(4),m=cup.matches[0]!;
 h.send(m.home,`!resultado ${m.code} 4x3`);
 assert.match(h.send('visitante',`!confronto ${m.home} x ${m.away}`).notices[0]!,/Jogos: 0/);
 h.send(m.away,'!confirmar');
 let text=h.send('visitante',`!confronto ${m.home} x ${m.away}`).notices[0]!;
 assert.match(text,/Jogos: 1/);assert.match(text,/Gols: 4 x 3/);
 h.send('admin',`!forcarresultado ${m.code} 1x2`);
 text=h.send('visitante',`!confronto ${m.home} x ${m.away}`).notices[0]!;
 assert.match(text,/Gols: 1 x 2/);
 assert.throws(()=>h.send('visitante','!confronto inexistente x u0'),/Nome/);
 assert.throws(()=>h.send('visitante',`!confronto ${m.home} x ${m.home}`),/diferentes/);
});

test('sorteio preserva pool e retrospecto rejeita homônimos',()=>{
 const pool=['Roma','Real Madrid','Barcelona','Liverpool','Bayern'];
 for(let i=0;i<30;i++){const shuffled=environment.shuffle(pool);assert.deepEqual([...shuffled].sort(),[...pool].sort());assert.notEqual(shuffled,pool);}
 assert.deepEqual(pool,['Roma','Real Madrid','Barcelona','Liverpool','Bayern']);
 const h=harness();const c=h.start(4);h.state.cups[c.id]!.participants[0]!.name='Arthur Silva';h.state.cups[c.id]!.participants[1]!.name='Arthur Souza';
 assert.throws(()=>h.send('visitante','!confronto Arthur x u2'),/ambíguo/);
 const a=c.participants[0]!.userId,b=c.participants[1]!.userId;
 assert.match(h.send('visitante',`!confrontoids ${a} ${b}`).notices[0]!,/Arthur Silva.*Arthur Souza/s);
 h.state.groups.other={authorized:true,admins:[],clubs};
 assert.throws(()=>h.send('visitante',`!confrontoids ${a} ${b}`,'another','other'),/registrado/);
});

test('lista aprovada de 89 clubes é usada no sorteio e preservada no restart',async()=>{
 const {minicampClubs}=await import('../src/minicamp/clubs.ts');
 assert.equal(minicampClubs.length,89);assert.equal(new Set(minicampClubs).size,89);
 for(const size of [4,8,16]){
  const h=harness();h.state.groups.g!.clubs=[...minicampClubs];
  assert.match(h.send('visitante','!clubes 5').notices[0]!,/Urawa Red Diamonds/);
  assert.doesNotMatch(h.send('visitante','!clubes').notices[0]!,/Urawa Red Diamonds/);
  const c=h.start(size);assert.equal(new Set(c.participants.map(p=>p.club)).size,size);
  assert.ok(c.participants.every(p=>minicampClubs.includes(p.club!)));
  const assignments=JSON.stringify(c.participants);h.restart();assert.equal(JSON.stringify(h.state.cups[c.id]!.participants),assignments);
 }
});

test('mensagens variam sem spam, sobrevivem a restart e final distingue campeão de vice', () => {
  const cheers = new Set<string>();
  const titles = new Set<string>();
  for (let offset = 0; offset < 8; offset++) {
    const h = harness(); h.state.nextCode += offset;
    const cup = h.start(4);
    for (const match of cup.matches) {
      h.send(match.home, `!resultado ${match.code} 2x1`);
      const event = { id: `confirm-${match.code}`, groupId: 'g', userId: match.away, name: match.away, text: `!confirmar ${match.code}`, at: 9999 };
      const expected = apply(h.state, event);
      assert.deepEqual(apply(JSON.parse(JSON.stringify(h.state)), event).notices, expected.notices);
      const reply = h.send(match.away, event.text);
      assert.ok(reply.notices.length <= 2);
      cheers.add(reply.notices[0]!.split('\n')[4]!);
    }
    const final = h.state.cups[cup.id]!.matches.at(-1)!;
    h.send(final.home, `!resultado ${final.code} 4x3`);
    const reply = h.send(final.away, `!confirmar ${final.code}`);
    assert.equal(reply.notices.length, 2);
    assert.match(reply.notices[0]!, /é campeão/);
    assert.match(reply.notices[0]!, /fica com o vice/);
    assert.doesNotMatch(reply.notices[0]!, /classificado|eliminado/);
    assert.match(reply.notices[1]!, /Primeira taça registrada/);
    titles.add(reply.notices[1]!.split('\n')[2]!);
  }
  assert.equal(cheers.size, 8);
  assert.equal(titles.size, 8);
});

test('menu usa exemplos genéricos sem nomes da comunidade', () => {
  const h = harness();
  const menu = h.send('u0', '!comandos').notices.join('\n');
  assert.doesNotMatch(menu, /Arthur|Lucas|Lukas/);
  assert.match(menu, /jogador A x jogador B/);
});

test('confirmação por placar, anulação e limpeza de Copa preservam estatísticas', () => {
 const h=harness();const cup=h.start(4);
 for(const m of cup.matches){
  h.send(m.away,`!resultado ${m.code} 4x3`);
  assert.throws(()=>h.send(m.away,'!confirmar 3x4'),/Placar diferente/);
  assert.throws(()=>h.send(m.home,'!confirmar 3x4'),/Placar diferente/);
  h.send(m.home,'!confirmar 4 x 3');
 }
 const final=h.state.cups[cup.id]!.matches.at(-1)!;
 assert.throws(()=>h.send('admin',`!deletar ${cup.matches[0]!.code}`),/outra fase/);
 h.send(final.home,'!resultado 2x1');h.send(final.away,'!confirmar 2x1');
 assert.throws(()=>h.send(final.home,`!deletar título ${final.code}`),/ADM/);
 h.send('admin',`!deletar título ${final.code}`);h.restart();
 assert.equal(h.state.cups[cup.id]!.champion,undefined);
 assert.equal(h.state.cups[cup.id]!.matches.at(-1)!.status,'scheduled');
 h.send(final.away,'!resultado 1x2');h.send(final.home,'!confirmar 1x2');
 assert.equal(h.state.cups[cup.id]!.champion,final.away);
 h.send('admin',`!anularcopa ${cup.id}`);
 assert.equal(h.state.cups[cup.id]!.status,'cancelled');
 assert.match(h.send(final.away,'!campeoes').notices[0]!,/Nenhum registro/);
 assert.throws(()=>h.send('admin',`!anularcopa ${cup.id}`),/já anulada/);
});

test('sair libera vaga antes do sorteio e propõe WO confirmado por outra pessoa depois',()=>{
 const h=harness();h.send('admin','!novacopa');h.send('admin','1');
 h.send('u0','!entrar');h.send('u1','!entrar');h.send('u0','!sair');h.restart();
 assert.equal(Object.values(h.state.cups)[0]!.participants.length,1);
 h.send('u0','!entrar');h.send('u2','!entrar');h.send('u3','!entrar');
 const cup=Object.values(h.state.cups)[0]!;const m=cup.matches[0]!;
 h.send(m.home,'!sair','withdraw');assert.deepEqual(h.send(m.home,'!sair','withdraw').notices,[]);
 assert.equal(h.state.cups[cup.id]!.matches[0]!.winner,undefined);
 assert.throws(()=>h.send(m.home,'!confirmar 3x0'),/Placar diferente/);
 h.restart();h.send(m.away,'!confirmar 0x3');
 assert.equal(h.state.cups[cup.id]!.matches[0]!.winner,m.away);
 assert.throws(()=>h.send(m.home,'!sair'),/não tem partida/);
});

test('correção antiga não reordena sequência e anulação não exibe placar obsoleto',()=>{
 const h=harness();const cup=h.start(4);
 const semi=cup.matches[0]!;
 for(const m of cup.matches){h.send(m.home,`!resultado ${m.code} 3x1`);h.send(m.away,`!confirmar ${m.code}`);}
 const final=h.state.cups[cup.id]!.matches.at(-1)!;
 h.send(final.home,`!resultado ${final.code} 0x2`);h.send(final.away,`!confirmar ${final.code}`);
 h.send('admin',`!forcarresultado ${semi.code} 2x0 ajuste de placar`);
 const stats=h.send(semi.home,'!stats').notices[0]!;
 assert.match(stats,/Vitórias seguidas: 0/);assert.match(stats,/Jogos: 2/);
 assert.match(stats,/Vitórias: 1/);assert.match(stats,/Derrotas: 1/);
 assert.match(stats,/Gols pró: 2/);assert.match(stats,/Gols contra: 2/);
 h.send('admin',`!deletar ${final.code}`);
 assert.doesNotMatch(h.send(final.home,`!jogo ${final.code}`).notices[0]!,/Placar:/);
 assert.match(h.send(final.home,`!jogo ${final.code}`).notices[0]!,/Sem placar/);
});

test('titulo consulta conquistas reais, não concede títulos e respeita anulações',()=>{
 const h=harness();const cup=h.start(4);
 assert.match(h.send('u0','!titulo').notices[0]!,/Total neste grupo: 0/);
 while(h.state.cups[cup.id]!.status!=='completed'){
  const m=h.state.cups[cup.id]!.matches.find(m=>m.status==='scheduled')!;
  h.send(m.home,`!resultado ${m.code} 2x1`);h.send(m.away,`!confirmar ${m.code}`);
 }
 const champion=h.state.cups[cup.id]!.champion!;
 const before=JSON.stringify(h.state.cups);
 assert.match(h.send('outsider',`!titulo ${champion}`).notices[0]!,/Total neste grupo: 1/);
 assert.equal(JSON.stringify(h.state.cups),before);
 h.restart();assert.match(h.send(champion,'!título').notices[0]!,/Total neste grupo: 1/);
 assert.throws(()=>h.send('u0','!titulo desconhecido'),/não encontrado/);
 h.send('admin',`!anularcopa ${cup.id}`);
 assert.match(h.send(champion,'!titulo').notices[0]!,/Total neste grupo: 0/);
});

test('titulo distingue homônimos e aceita acentos no nome',()=>{
 const h=harness();const cup=h.start(4);
 h.state.cups[cup.id]!.participants[0]!.name='André Silva';h.state.cups[cup.id]!.participants[1]!.name='André Souza';
 assert.throws(()=>h.send('u0','!titulo Andre'),/mais de uma/);
 assert.match(h.send('u0','!titulo ANDRE SILVA').notices[0]!,/André Silva/);
});

test('teste é diagnóstico sem mutação de Copa e não declara banco verificado no domínio',()=>{
 const h=harness();
 const empty=h.send('admin','!teste').notices[0]!;
 assert.match(empty,/Nenhuma Copa ativa/);assert.doesNotMatch(empty,/PostgreSQL:/);
 const cup=h.start(4);const before=JSON.stringify(h.state.cups);
 const reply=h.send('u0','!teste','diagnostic');
 assert.match(reply.notices[0]!,/Edição 1 · em andamento/);
 assert.equal(JSON.stringify(h.state.cups),before);
 assert.deepEqual(h.send('u0','!teste','diagnostic').notices,[]);
 h.state.groups.g!.clubs=['Clube'];h.state.groups.g!.admins=[];
 const warning=h.send('u0','!teste').notices[0]!;
 assert.match(warning,/⚠️ ADMs cadastrados: 0/);assert.match(warning,/⚠️ Clubes disponíveis: 1/);
 assert.equal(h.state.cups[cup.id]!.status,'playing');
});

 test('supabase não muda Copa, valida sintaxe e só adaptador pode atestar banco',()=>{
 const h=harness(); const cup=h.start(4);const before=JSON.stringify(cup);
 const reply=h.send('u0','!supabase','db-check').notices[0]!;
 assert.match(reply,/DIAGNÓSTICO SUPABASE/);assert.doesNotMatch(reply,/gravação.*verificadas/);
 assert.equal(JSON.stringify(h.state.cups[cup.id]),before);
 assert.deepEqual(h.send('u0','!supabase','db-check').notices,[]);
 assert.throws(()=>h.send('u0','!supabase extra'),/Formato/);
 });

test('jornada, arquivo e vistoria têm identidade própria e preservam o estado',()=>{
 const h=harness();
 assert.throws(()=>h.send('u0','!vistoria'),/ADM/);
 assert.match(h.send('admin','!vistoria').notices[0]!,/Nenhuma Copa ativa/);
 h.send('admin','!novacopa');h.send('admin','3');
 for(let i=0;i<16;i++)h.send(`u${i}`,'!entrar');
 const current=Object.values(h.state.cups)[0]!;
 const snapshot=JSON.stringify(h.state.cups);
 assert.match(h.send('u0','!jornada').notices[0]!,/CARREIRA NA ARENA/);
 assert.match(h.send('u0','!jornada u1').notices[0]!,/u1/);
 const first=h.send('u0','!arquivo').notices[0]!;
 assert.match(first,/ARQUIVO DA ARENA · 1\/2/);
 assert.match(first,/!arquivo 2/);
 const second=h.send('u0','!arquivo 2').notices[0]!;
 assert.match(second,/ARQUIVO DA ARENA · 2\/2/);
 assert.doesNotMatch(second,/!arquivo 3/);
 assert.throws(()=>h.send('u0','!arquivo 3'),/Página inválida/);
 assert.match(h.send('admin','!vistoria').notices[0]!,/partidas a jogar/);
 assert.equal(JSON.stringify(h.state.cups),snapshot);
 const match=current.matches[0]!;
 const proposal=h.send(match.home,`!resultado ${match.code} 3x1`).notices[0]!;
 assert.match(proposal,/Aguardando confirmação/);
 assert.match(h.send('admin','!vistoria').notices[0]!,new RegExp(`#${match.code}`));
 h.send(match.away,`!contestar ${match.code}`);
 assert.match(h.send('admin','!vistoria').notices[0]!,/Resolver disputa/);
});

test('arquivo não mistura grupos nem mostra Copa anulada',()=>{
 const h=harness();h.start(4);
 h.state.groups.other={authorized:true,admins:['admin'],clubs};
 assert.match(h.send('admin','!arquivo','out-1','other').notices[0]!,/Ainda não há inscrições/);
 const cup=Object.values(h.state.cups)[0]!;
 h.send('admin',`!anularcopa ${cup.id}`);
 assert.match(h.send('admin','!arquivo').notices[0]!,/Ainda não há inscrições/);
});


test('Copa de seleções aceita 32 vagas, sorteia sem repetição e mantém histórico do grupo',()=>{
 const h=harness();h.state.groups.g={authorized:true,admins:['admin'],clubs:Array.from({length:36},(_,i)=>`Seleção ${i+1}`),competitionName:'Copa do Mundo MLG',teamKind:'seleção'};
 h.send('admin','!novacopa');h.send('admin','!formato 32');
 for(let i=0;i<32;i++)h.send(`j${i}`,'!entrar');
 const cup=Object.values(h.state.cups)[0]!;
 assert.equal(cup.size,32);assert.equal(cup.matches.length,16);assert.equal(new Set(cup.participants.map(p=>p.club)).size,32);
 assert.match(h.send('j0','!copa').notices[0]!,/COPA DO MUNDO MLG/);
 assert.match(h.send('j0','!times').notices[0]!,/SELEÇÕES/);
 assert.match(h.send('j0','!comandos').notices[0]!,/COPA DO MUNDO MLG/);
 h.state.groups.outro={authorized:true,admins:['admin'],clubs,competitionName:'Copa dos Clubes'};
 assert.match(h.send('admin','!teste',undefined,'outro').notices[0]!,/Nenhuma Copa ativa/);
 assert.equal(Object.values(h.state.cups).filter(c=>c.groupId==='outro').length,0);
});

test('predefinição da Copa oferece 36 seleções únicas para revisão no painel',()=>{
 assert.equal(worldCupCandidates.length,36);
 assert.equal(new Set(worldCupCandidates).size,36);
 for(const name of ['Espanha','Holanda','Noruega','Irã','Costa do Marfim','Rússia','Polônia'])assert.ok(worldCupCandidates.includes(name),name);
 assert.ok(!worldCupCandidates.includes('Gana'));
});

test('Minicamp aceita sorteio misto de clubes e seleções sem repetição',()=>{
 const h=harness();h.state.groups.g={authorized:true,admins:['admin'],clubs:[...clubs,...worldCupCandidates],teamKind:'misto',competitionName:'Minicamp MLG'};
 h.send('admin','!novacopa');h.send('admin','!formato 32');
 for(let i=0;i<31;i++)h.send('m'+i,'!entrar');
 const final=h.send('m31','!entrar').notices.join('\n');
 assert.match(final,/Equipes e adversários aparecem juntos/);assert.equal((final.match(/^🎮 JOGO \d+/gm)??[]).length,16);
 const cup=Object.values(h.state.cups)[0]!;
 assert.equal(cup.participants.length,32);
 assert.equal(new Set(cup.participants.map(p=>p.club)).size,32);
});
