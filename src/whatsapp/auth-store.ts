import { initAuthCreds, BufferJSON, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { Pool, PoolClient } from 'pg';
import { seal, unseal } from '../infra/security.ts';

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
      // Capture mutable creds now; serialize writes to avoid an older update
      // overwriting newer auth state. Failed saves remain visible to callers.
      const snapshot=JSON.parse(JSON.stringify(state.creds,BufferJSON.replacer),BufferJSON.reviver);
      const next=saving.then(()=>write(pool,'creds','current',snapshot));
      saving=next.catch(()=>undefined); return next;
    },
    flush:()=>saving,
  };
}
