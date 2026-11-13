import test from 'node:test';
import assert from 'node:assert/strict';
import { initAuthCreds } from '@whiskeysockets/baileys';
import type { Pool } from 'pg';
import { importAuthSnapshotIfEmpty } from '../src/whatsapp/auth-store.ts';

class FakePool {
  records: { account: string; category: string; id: string }[] = [];
  connectCalls = 0;

  async connect() {
    this.connectCalls++;
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.startsWith('SELECT 1 FROM mlg_bot.wa_auth')) {
          const found = this.records.some(record => record.account === values[0]);
          return { rows: found ? [{}] : [], rowCount: found ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO mlg_bot.wa_auth')) {
          this.records.push({
            account: String(values[0]),
            category: String(values[1]),
            id: String(values[2]),
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }
}

function snapshot(registered = true) {
  const creds = initAuthCreds();
  creds.registered = registered;
  return {
    creds,
    keys: {
      'pre-key': { 'key-1': { private: Buffer.from('private'), public: Buffer.from('public') } },
      'app-state-sync-key': { 'sync-1': { keyData: Buffer.from('state') } },
    },
  };
}

test('importa a sessão legada apenas quando a conta ainda não tem autenticação', async () => {
  const pool = new FakePool();
  const imported = await importAuthSnapshotIfEmpty(
    pool as unknown as Pool,
    'secondary',
    Buffer.alloc(32, 7),
    snapshot(),
  );

  assert.equal(imported, true);
  assert.equal(pool.records.length, 3);
  assert.deepEqual(
    pool.records.map(record => record.category).sort(),
    ['app-state-sync-key', 'creds', 'pre-key'],
  );
});

test('não sobrescreve nenhuma sessão já existente no banco', async () => {
  const pool = new FakePool();
  pool.records.push({ account: 'secondary', category: 'creds', id: 'current' });

  const imported = await importAuthSnapshotIfEmpty(
    pool as unknown as Pool,
    'secondary',
    Buffer.alloc(32, 7),
    snapshot(),
  );

  assert.equal(imported, false);
  assert.equal(pool.records.length, 1);
});

test('não importa credenciais legadas sem registro WhatsApp válido', async () => {
  const pool = new FakePool();

  const imported = await importAuthSnapshotIfEmpty(
    pool as unknown as Pool,
    'secondary',
    Buffer.alloc(32, 7),
    snapshot(false),
  );

  assert.equal(imported, false);
  assert.equal(pool.connectCalls, 0);
  assert.equal(pool.records.length, 0);
});
