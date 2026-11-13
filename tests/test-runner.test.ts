import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTestFailures } from '../scripts/test-result.ts';

test('relatório TAP verde não é tratado como falha', () => {
  assert.equal(hasTestFailures('1..2\n# tests 2\n# pass 2\n# fail 0\n'), false);
});

test('relatório TAP vermelho é detectado mesmo com processo retornando zero', () => {
  assert.equal(hasTestFailures('1..2\nnot ok 2 - regression\n# tests 2\n# pass 1\n# fail 1\n'), true);
});

test('resumo com múltiplas falhas é detectado', () => {
  assert.equal(hasTestFailures('# tests 12\n# pass 9\n# fail 3\n'), true);
});

test('linhas comuns com a palavra fail não provocam falso positivo', () => {
  assert.equal(hasTestFailures('# fail 0\n# todo 1\n# Subtest: failed network is retried\n'), false);
});
