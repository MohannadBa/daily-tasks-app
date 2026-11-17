import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM field encryption for personal tasks. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url),
 * with the owner's user id as additional authenticated data (ciphertext cannot be moved between users).
 *
 * Key rotation: construct with [current, previous]. New data is always encrypted with the current
 * key; decryption tries the current key and then the previous one (GCM authentication makes a wrong
 * key fail reliably) and reports `stale` so callers can re-encrypt. `rekey-personal` re-encrypts
 * every row; afterwards the previous key can be retired. See docs/OPERATIONS.md.
 */
export class PersonalCipher {
  private readonly keys: Buffer[];

  constructor(secrets: Array<string | undefined | null>) {
    const usable = secrets.filter((s): s is string => !!s && s.length > 0);
    if (usable.length === 0) throw new Error('PersonalCipher: no key configured');
    this.keys = usable.map((s) => createHash('sha256').update(s).digest());
  }

  encrypt(plain: string, ownerId: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys[0]!, iv);
    c.setAAD(Buffer.from(ownerId));
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
  }

  /** Decrypts with the current key, falling back to older keys; `stale` = not the current key. */
  decrypt(value: string, ownerId: string): { plain: string; stale: boolean } {
    const [v, iv, tag, data] = value.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unsupported ciphertext');
    let lastError: unknown;
    for (const [i, key] of this.keys.entries()) {
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        d.setAAD(Buffer.from(ownerId));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        const plain = Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
        return { plain, stale: i > 0 };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Decryption failed');
  }
}
