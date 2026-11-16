import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { acquireWhatsAppSessionLeader, WHATSAPP_SESSION_LOCK_ID } from '../src/infra/session-leader.ts';

test('session leader keeps its PostgreSQL client until the caller releases it', async () => {
  let released = false;
  let queryText = '';
  let queryValues: unknown[] = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      queryText = sql; queryValues = values; return { rows: [{ acquired: true }] };
    },
    release: () => { released = true; },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const acquired = await acquireWhatsAppSessionLeader(pool);
  assert.equal(acquired, client);
  assert.match(queryText, /pg_try_advisory_lock/);
  assert.deepEqual(queryValues, [WHATSAPP_SESSION_LOCK_ID]);
  assert.equal(released, false);
  acquired.release();
  assert.equal(released, true);
});

test('failed acquisition releases the PostgreSQL client', async () => {
  let released = false;
  const client = {
    query: async () => ({ rows: [{ acquired: false }] }),
    release: () => { released = true; },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(() => acquireWhatsAppSessionLeader(pool), /Another worker already owns/);
  assert.equal(released, true);
});

test('query failure releases the PostgreSQL client', async () => {
  let released = false;
  const client = {
    query: async () => { throw new Error('database unavailable'); },
    release: () => { released = true; },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  await assert.rejects(() => acquireWhatsAppSessionLeader(pool), /database unavailable/);
  assert.equal(released, true);
});

const integration = { skip: !process.env.MLG_TEST_DATABASE_URL };
test('PostgreSQL advisory lock rejects a second WhatsApp worker until the first releases it', integration, async () => {
  const connectionString = process.env.MLG_TEST_DATABASE_URL!;
  const firstPool = new Pool({ connectionString, max: 1 });
  const secondPool = new Pool({ connectionString, max: 1 });
  const testLockId = WHATSAPP_SESSION_LOCK_ID + 1;
  try {
    const first = await acquireWhatsAppSessionLeader(firstPool, testLockId);
    await assert.rejects(
      () => acquireWhatsAppSessionLeader(secondPool, testLockId),
      /Another worker already owns/,
    );
    await first.query('SELECT pg_advisory_unlock($1)', [testLockId]);
    first.release();
    const second = await acquireWhatsAppSessionLeader(secondPool, testLockId);
    second.release();
  } finally {
    await firstPool.end();
    await secondPool.end();
  }
});
