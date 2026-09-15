import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { seal, unseal, reconnect } from '../src/infra/security.ts';
import { allowBanter, approveMemory, type Memory } from '../src/resenha/policy.ts';

test('sessão cifrada: roundtrip, nonce novo, chave/contexto adulterados rejeitados', () => {
  const key = randomBytes(32);
  const first = seal('private-session', key, 'account:creds');
  assert.equal(unseal(first, key, 'account:creds'), 'private-session');
  assert.notDeepEqual(first, seal('private-session', key, 'account:creds'));
  assert.ok(!JSON.stringify(first).includes('private-session'));
  assert.throws(() => unseal(first, randomBytes(32), 'account:creds'));
  assert.throws(() => unseal(first, key, 'different-account:creds'));
  assert.throws(() => unseal({ ...first, tag: randomBytes(16).toString('base64') }, key, 'account:creds'));
  assert.throws(() => seal('private-session', randomBytes(16), 'account:creds'));
});

test('reconnect cresce, tem teto e sessão revogada exige pareamento', () => {
  assert.equal(reconnect('logged-out', 0, 0.5).state, 'NEEDS_PAIRING');
  assert.equal(reconnect('connection-replaced', 0, 0.5).state, 'STOPPED');
  assert.equal(reconnect('transient', 0, 0.5).delayMs, 1500);
  assert.ok(reconnect('transient', 5, 0.5).delayMs! > reconnect('transient', 1, 0.5).delayMs!);
  for (const attempt of [10, 100, 10000]) {
    const r = reconnect('transient', attempt, 0.99);
    assert.ok(r.delayMs! <= 300000 && r.delayMs! > 0);
  }
});

test('resenha respeita autorização, opt-out, cooldown e limite espontâneo', () => {
  const config = { authorized: true, optedOut: false, enabled: true, spontaneous: false, lastGroupAt: 0, lastUserAt: 0, spontaneousLastHour: 0 };
  assert.equal(allowBanter(config, 'mention', 61000), true);
  assert.equal(allowBanter(config, 'spontaneous', 61000), false);
  assert.equal(allowBanter({ ...config, spontaneous: true }, 'spontaneous', 61000), true);
  assert.equal(allowBanter({ ...config, spontaneous: true, spontaneousLastHour: 2 }, 'spontaneous', 61000), false);
  assert.equal(allowBanter({ ...config, authorized: false }, 'mention', 61000), false);
  assert.equal(allowBanter({ ...config, optedOut: true }, 'reply', 61000), false);
  assert.equal(allowBanter({ ...config, lastGroupAt: 60000 }, 'command', 61000), false);
  assert.equal(allowBanter({ ...config, lastUserAt: 50000 }, 'event', 61000), false);
});

test('memória candidata exige ADM e fonte; aprovação não permite promover estatística inventada', () => {
  const candidate: Memory = { id: 'm1', groupId: 'g', kind: 'rivalry', subjects: ['u1', 'u2'], text: 'Clássico do grupo', source: 'review:1', status: 'candidate' };
  assert.throws(() => approveMemory(candidate, 'outsider', ['admin']), /ADM/);
  const approved = approveMemory(candidate, 'admin', ['admin']);
  assert.equal(approved.status, 'approved');
  assert.equal(candidate.status, 'candidate');
  assert.throws(() => approveMemory({ ...candidate, source: '' }, 'admin', ['admin']), /fonte/);
  assert.throws(() => approveMemory({ ...candidate, kind: 'championship' }, 'admin', ['admin']), /resultado/);
});
