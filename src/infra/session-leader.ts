import type { Pool, PoolClient } from 'pg';

// Shared by the primary WhatsApp worker modes. The lock is session-scoped and
// must stay on this client for the entire lifetime of the Baileys connection.
export const WHATSAPP_SESSION_LOCK_ID = 71012028;

export async function acquireWhatsAppSessionLeader(
  pool: Pick<Pool, 'connect'>,
  lockId = WHATSAPP_SESSION_LOCK_ID,
): Promise<PoolClient> {
  if (!Number.isSafeInteger(lockId)) throw new Error('Invalid WhatsApp session lock id');
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockId],
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error('Another worker already owns the WhatsApp session');
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}
