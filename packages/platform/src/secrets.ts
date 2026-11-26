import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Tx } from '@aiw/db';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for secrets at rest (refresh tokens, PKCE verifiers).
 * The key is 32 random bytes, base64-encoded, from TOKEN_ENCRYPTION_KEY.
 * Output: "v1.<iv>.<tag>.<ciphertext>", all base64url.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
    this.key = key;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), body]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  /** Throws if the value was tampered with or sealed with another key. */
  open(sealed: string): string {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || body === undefined) {
      throw new Error('Unrecognized secret format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** Store a secret encrypted; returns its reference. Call inside withTenant. */
export async function storeSecret(
  trx: Tx,
  box: SecretBox,
  orgId: string,
  purpose: string,
  value: string,
): Promise<string> {
  const row = await trx
    .insertInto('platform.secrets')
    .values({ org_id: orgId, purpose, ciphertext: box.seal(value) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function readSecret(trx: Tx, box: SecretBox, ref: string): Promise<string | null> {
  const row = await trx
    .selectFrom('platform.secrets')
    .select('ciphertext')
    .where('id', '=', ref)
    .executeTakeFirst();
  return row ? box.open(row.ciphertext) : null;
}

export async function deleteSecret(trx: Tx, ref: string): Promise<void> {
  await trx.deleteFrom('platform.secrets').where('id', '=', ref).execute();
}
