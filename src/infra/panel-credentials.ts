import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const hash = async (password: string, salt: string) => (await scrypt(password, Buffer.from(salt, 'hex'), 32)) as Buffer;
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
type Stored = {version: 1; salt: string; digest: string};

// Separate private vault object: the WhatsApp session object is never read or overwritten here.
export function panelCredentials(vaultUrl: string, token: string, initialPassword: string) {
  const endpoint = vaultUrl.replace(/\/+$/, '') + '/panel-credentials';
  const headers = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
  let rotating = false;
  async function current(): Promise<Stored | null> {
    const response = await fetch(endpoint, {headers, signal: AbortSignal.timeout(12000), cache: 'no-store'});
    if (!response.ok) throw Error('Credential vault unavailable');
    const data = await response.json() as {value: Stored | null};
    if (data.value !== null && (data.value?.version !== 1 || !/^[0-9a-f]{32}$/.test(data.value.salt) || !/^[0-9a-f]{64}$/.test(data.value.digest))) throw Error('Invalid credential record');
    return data.value;
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
    if (rotating) throw Error('Outra troca de senha está em andamento.');
    rotating = true;
    try {
    if (typeof next !== 'string' || next.length < 32 || next.length > 128 || /[\r\n\u0000-\u001f\u007f]/.test(next)) throw Error('Senha nova deve ter de 32 a 128 caracteres, sem espaços de controle.');
    if (!await verify(header)) throw Error('Senha atual inválida.');
    if (header?.slice(7) === next) throw Error('Escolha uma senha diferente.');
    const salt = randomBytes(16).toString('hex');
    const value: Stored = {version: 1, salt, digest: (await hash(next, salt)).toString('hex')};
    const response = await fetch(endpoint, {method: 'PUT', headers, body: JSON.stringify(value), signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw Error('Não foi possível salvar a nova senha. Tente novamente.');
    } finally { rotating = false; }
  }
  return { verify, rotate };
}
