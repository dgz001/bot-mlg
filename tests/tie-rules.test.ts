import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTie } from '../src/minicamp/tie-rules.ts';

test('a primeira partida não libera a próxima fase e a volta inverte o mando', () => {
  assert.deepEqual(decideTie('home-and-away', { home: 1, away: 0 }), {
    status: 'awaiting-second', aggregate: { home: 1, away: 0 },
  });
  assert.deepEqual(decideTie('home-and-away', { home: 1, away: 0 }, { home: 2, away: 0 }), {
    status: 'decided', aggregate: { home: 1, away: 2 }, winner: 'away', by: 'aggregate',
  });
});

test('empate no agregado aguarda pênaltis, sem classificar por gol fora', () => {
  const first = { home: 2, away: 1 }, second = { home: 1, away: 0 };
  assert.deepEqual(decideTie('home-and-away', first, second), {
    status: 'awaiting-penalties', aggregate: { home: 2, away: 2 },
  });
  assert.deepEqual(decideTie('home-and-away', first, second, { home: 4, away: 5 }), {
    status: 'decided', aggregate: { home: 2, away: 2 }, winner: 'away', by: 'penalties', penalties: { home: 4, away: 5 },
  });
});

test('não aceita volta antecipada, pênaltis desnecessários ou modalidade errada', () => {
  assert.throws(() => decideTie('home-and-away', undefined, { home: 1, away: 0 }), /primeira partida/);
  assert.throws(() => decideTie('home-and-away', { home: 1, away: 0 }, undefined, { home: 4, away: 3 }), /após confirmar/);
  assert.throws(() => decideTie('home-and-away', { home: 3, away: 0 }, { home: 1, away: 0 }, { home: 4, away: 3 }), /agregado já definiu/);
  assert.throws(() => decideTie('single', { home: 1, away: 1 }), /decisivo/);
  assert.throws(() => decideTie('single', { home: 1, away: 0 }, { home: 0, away: 1 }), /partida única/);
  assert.throws(() => decideTie('home-and-away', { home: -1, away: 0 }), /inválido/);
});
