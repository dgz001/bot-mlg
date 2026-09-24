import { Pool } from 'pg';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const hash = async (password: string, salt: string) => (await scrypt(password, Buffer.from(salt, 'hex'), 32)) as Buffer;
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export function panelCredentials(databaseUrl: string, initialPassword: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 10000 });
  async function current() {
    const result = await pool.query<{salt: string; digest: string}>('SELECT salt,digest FROM mlg_bot.panel_credentials WHERE id=true');
    return result.rows[0];
  }
  async function verify(header: string | undefined) {
    if (!header?.startsWith('Bearer ') || header.length > 512) return false;
    const password = header.slice(7);
    const row = await current();
    if (row) return same(await hash(password, row.salt), Buffer.from(row.digest, 'hex'));
    if (initialPassword.length < 32) return false;
    const salt = '00000000000000000000000000000000';
    return same(await hash(password, salt), await hash(initialPassword, salt));
  }
  async function rotate(header: string | undefined, next: unknown) {
    if (typeof next !== 'string' || next.length < 32 || next.length > 128 || /[\r\n\u0000-\u001f\u007f]/.test(next)) throw Error('Senha nova deve ter de 32 a 128 caracteres, sem espaços de controle.');
    if (!await verify(header)) throw Error('Senha atual inválida.');
    if (header?.slice(7) === next) throw Error('Escolha uma senha diferente.');
    const salt = randomBytes(16).toString('hex');
    const digest = (await hash(next, salt)).toString('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const previous = await client.query<{salt: string; digest: string}>('SELECT salt,digest FROM mlg_bot.panel_credentials WHERE id=true FOR UPDATE');
      if (previous.rows[0]) {
        if (!header || !same(await hash(header.slice(7), previous.rows[0].salt), Buffer.from(previous.rows[0].digest, 'hex'))) throw Error('Senha alterada por outra sessão. Entre novamente.');
        await client.query('UPDATE mlg_bot.panel_credentials SET salt=$1,digest=$2,changed_at=now() WHERE id=true', [salt, digest]);
      } else {
        if (header?.slice(7) !== initialPassword) throw Error('Senha atual inválida.');
        await client.query('INSERT INTO mlg_bot.panel_credentials(id,salt,digest) VALUES(true,$1,$2)', [salt, digest]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  return { verify, rotate, close: () => pool.end() };
}
