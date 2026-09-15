import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type Sealed = { version: 1; nonce: string; tag: string; ciphertext: string };
export function seal(plaintext: string, key: Buffer, context: string): Sealed {
  if (key.length !== 32 || !context) throw new Error('Invalid encryption configuration');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function unseal(value: Sealed, key: Buffer, context: string): string {
  if (value.version !== 1 || key.length !== 32 || !context) throw new Error('Invalid encryption configuration');
  const nonce = Buffer.from(value.nonce, 'base64'), tag = Buffer.from(value.tag, 'base64');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted record');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

// Decision function only; timer/socket lifecycle is implemented in the worker phase.
export function reconnect(reason: 'transient' | 'logged-out' | 'connection-replaced', attempt: number, random: number): { state: 'BACKOFF' | 'NEEDS_PAIRING' | 'STOPPED'; delayMs?: number } {
  if (reason === 'logged-out') return { state: 'NEEDS_PAIRING' };
  if (reason === 'connection-replaced') return { state: 'STOPPED' };
  if (!Number.isSafeInteger(attempt) || attempt < 0 || !Number.isFinite(random) || random < 0 || random > 1) throw new Error('Invalid backoff input');
  const ceiling = Math.min(300000, 2000 * 2 ** Math.min(attempt, 20));
  return { state: 'BACKOFF', delayMs: Math.floor(ceiling * (0.5 + random * 0.5)) };
}
