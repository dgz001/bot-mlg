import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, emptyState, environment, type State } from '../src/minicamp/engine.ts';

const clubs = Array.from({ length: 20 }, (_, i) => `Clube ${i + 1}`);
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
    assert.ok(h.send('u0', '!campeoes').notices.join('\n').includes(cup.champion!));
    h.send('admin', '!novacopa');
    h.send('admin', '1');
    assert.equal(Object.values(h.state.cups).filter(c => c.status === 'completed').length, 1);
  });
}

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
  h.send(m.home, `!resultado ${m.code} 2x0`);
  const before = JSON.stringify(h.state);
  assert.throws(() => h.send(m.home, `!confirmar ${m.code}`), /próprio/);
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

test('ADM proponente não confirma nem resolve sozinho sua proposta', () => {
  const h = harness();
  const m = h.start(4).matches[0]!;
  h.state.groups.g!.admins.push(m.home);
  h.send(m.home, `!resultado ${m.code} 2x0`);
  assert.throws(() => h.send(m.home, `!confirmar ${m.code}`), /próprio/);
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
 assert.throws(()=>h.send('admin','!titulo qualquer pessoa'),/desconhecido/);
});

test('placar sem código, visitante, confirmação e ambiguidade de ADM', () => {
 const h=harness();const cup=h.start(4),[a,b]=cup.matches;
 assert.throws(()=>h.send('admin',`!resultado ${a!.code} 4x3`),/jogadores/);
 h.send(a!.away,'!resultado 4 x 3');
 assert.throws(()=>h.send(a!.away,'!confirmar'),/próprio/);
 h.send(b!.home,'!resultado 2x1');
 assert.throws(()=>h.send('admin','!confirmar'),/código/);
 h.send(a!.home,'!confirmar');
 assert.equal(h.state.cups[cup.id]!.matches[0]!.winner,a!.home);
 h.send('admin','!confirmar');
 assert.equal(h.state.cups[cup.id]!.matches[1]!.winner,b!.home);
 assert.throws(()=>h.send('stranger','!resultado 1x0'),/partida/);
});
