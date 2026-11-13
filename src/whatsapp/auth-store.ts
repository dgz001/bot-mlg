import { initAuthCreds, BufferJSON, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { Pool, PoolClient } from 'pg';
import { seal, unseal } from '../infra/security.ts';
import { vaultAuth } from './vault-auth.ts';

type AuthSnapshot = {
  creds: AuthenticationState['creds'];
  keys: Record<string, Record<string, unknown>>;
};

/**
 * Import the existing WhatsApp credentials only when this account has no
 * auth rows yet. The legacy vault is read-only; its data is never cleared.
 */
export async function importAuthSnapshotIfEmpty(
  pool: Pool,
  account: string,
  key: Buffer,
  snapshot: AuthSnapshot,
): Promise<boolean> {
  if (key.length !== 32) throw new Error('Invalid encryption key');
  if (!snapshot.creds.registered) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [71012029]);
    const existing = await client.query(
      'SELECT 1 FROM mlg_bot.wa_auth WHERE account_id=$1 LIMIT 1',
      [account],
    );
    if (existing.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }

    const write = async (category: string, id: string, value: unknown) => {
      const sealed = seal(
        JSON.stringify(value, BufferJSON.replacer),
        key,
        JSON.stringify([account, category, id]),
      );
      await client.query(
        `INSERT INTO mlg_bot.wa_auth(account_id,category,key_id,key_version,nonce,auth_tag,ciphertext)
         VALUES($1,$2,$3,1,$4,$5,$6)`,
        [
          account,
          category,
          id,
          Buffer.from(sealed.nonce, 'base64'),
          Buffer.from(sealed.tag, 'base64'),
          Buffer.from(sealed.ciphertext, 'base64'),
        ],
      );
    };

    await write('creds', 'current', snapshot.creds);
    for (const [category, entries] of Object.entries(snapshot.keys)) {
      for (const [id, value] of Object.entries(entries ?? {})) {
        if (value !== null && value !== undefined) await write(category, id, value);
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function authStore(pool: Pool, account: string, key: Buffer) {
  if (key.length !== 32) throw new Error('Invalid encryption key');
  const context = (category: string,id: string) => JSON.stringify([account,category,id]);
  async function read(category: string,id: string): Promise<unknown | null> {
    const r = await pool.query('SELECT nonce,auth_tag,ciphertext,key_version FROM mlg_bot.wa_auth WHERE account_id=$1 AND category=$2 AND key_id=$3',[account,category,id]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    if(row.key_version!==1) throw new Error('Unsupported auth key version');
    const plain = unseal({version:1,nonce:row.nonce.toString('base64'),tag:row.auth_tag.toString('base64'),ciphertext:row.ciphertext.toString('base64')},key,context(category,id));
    return JSON.parse(plain,BufferJSON.reviver);
  }
  async function write(q: Pool | PoolClient,category:string,id:string,value:unknown) {
    if (value === null || value === undefined) {
      await q.query('DELETE FROM mlg_bot.wa_auth WHERE account_id=$1 AND category=$2 AND key_id=$3',[account,category,id]); return;
    }
    const v = seal(JSON.stringify(value,BufferJSON.replacer),key,context(category,id));
    await q.query(`INSERT INTO mlg_bot.wa_auth(account_id,category,key_id,key_version,nonce,auth_tag,ciphertext)
      VALUES($1,$2,$3,1,$4,$5,$6) ON CONFLICT(account_id,category,key_id) DO UPDATE SET nonce=excluded.nonce,auth_tag=excluded.auth_tag,ciphertext=excluded.ciphertext,key_version=1`,
    [account,category,id,Buffer.from(v.nonce,'base64'),Buffer.from(v.tag,'base64'),Buffer.from(v.ciphertext,'base64')]);
  }

  const vaultUrl = process.env.SESSION_VAULT_URL;
  const vaultToken = process.env.SESSION_VAULT_TOKEN;
  if (Boolean(vaultUrl) !== Boolean(vaultToken)) {
    throw new Error('Incomplete legacy session vault configuration');
  }
  if (vaultUrl && vaultToken) {
    const existing = await pool.query(
      'SELECT 1 FROM mlg_bot.wa_auth WHERE account_id=$1 LIMIT 1',
      [account],
    );
    if (!existing.rowCount) {
      const legacy = await vaultAuth(vaultUrl, vaultToken, key);
      if (await importAuthSnapshotIfEmpty(pool, account, key, legacy.data)) {
        console.log(JSON.stringify({ event: 'WA_AUTH_IMPORTED_FROM_LEGACY_VAULT' }));
      }
    }
  }

  const creds = await read('creds','current') as AuthenticationState['creds'] | null;
  const state: AuthenticationState = {
    creds: creds ?? initAuthCreds(),
    keys: {
      async get<T extends keyof SignalDataTypeMap>(category:T,ids:string[]) {
        const out: { [id:string]: SignalDataTypeMap[T] } = {};
        for(const id of ids) {
          let value=await read(category,id);
          if(category==='app-state-sync-key' && value) value=proto.Message.AppStateSyncKeyData.fromObject(value as Record<string,unknown>);
          if(value!==null) out[id]=value as SignalDataTypeMap[T];
        }
        return out;
      },
      async set(data) {
        const q=await pool.connect();
        try {
          await q.query('BEGIN');
          for(const [category,entries] of Object.entries(data)) for(const [id,value] of Object.entries(entries ?? {})) await write(q,category,id,value);
          await q.query('COMMIT');
        } catch(error) { await q.query('ROLLBACK').catch(()=>undefined); throw error; }
        finally {q.release();}
      },
    },
  };
  let saving=Promise.resolve();
  return {
    state,
    save() {
      const snapshot=JSON.parse(JSON.stringify(state.creds,BufferJSON.replacer),BufferJSON.reviver);
      const next=saving.then(()=>write(pool,'creds','current',snapshot));
      saving=next.catch(()=>undefined); return next;
    },
    flush:()=>saving,
  };
}
