import { describe, expect, it } from 'vitest';
import { PersonalCipher } from '../src/personal-cipher';
import { rekeyPersonalTasks } from '../src/rekey-personal';

const OLD = 'old-key-old-key-old-key-old-key-0001';
const NEW = 'new-key-new-key-new-key-new-key-0002';

describe('PersonalCipher (AES-256-GCM, owner-bound, rotatable)', () => {
  it('round-trips and binds ciphertext to its owner', () => {
    const c = new PersonalCipher([NEW]);
    const enc = c.encrypt('Call the dentist', 'user-a');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('dentist');
    expect(c.decrypt(enc, 'user-a')).toEqual({ plain: 'Call the dentist', stale: false });
    expect(() => c.decrypt(enc, 'user-b')).toThrow();
  });

  it('decrypts old-key rows during rotation (stale), new rows use the new key, wrong keys fail', () => {
    const oldEnc = new PersonalCipher([OLD]).encrypt('legacy', 'u');
    const rotating = new PersonalCipher([NEW, OLD]);
    expect(rotating.decrypt(oldEnc, 'u')).toEqual({ plain: 'legacy', stale: true });
    const fresh = rotating.encrypt('fresh', 'u');
    expect(new PersonalCipher([NEW]).decrypt(fresh, 'u').plain).toBe('fresh');
    expect(() => new PersonalCipher([NEW]).decrypt(oldEnc, 'u')).toThrow(); // old key retired too early
    expect(() => new PersonalCipher(['', null, undefined])).toThrow();
  });

  it('rekey re-encrypts only stale rows, is idempotent, and counts undecryptable rows without touching them', async () => {
    const old = new PersonalCipher([OLD]);
    const rows = [
      { id: '1', ownerId: 'u', titleEnc: old.encrypt('a', 'u'), notesEnc: old.encrypt('n', 'u') },
      { id: '2', ownerId: 'u', titleEnc: new PersonalCipher([NEW]).encrypt('b', 'u'), notesEnc: null },
      { id: '3', ownerId: 'u', titleEnc: new PersonalCipher(['third-key-third-key-third-key-0003']).encrypt('c', 'u'), notesEnc: null },
    ];
    const prisma = {
      personalTask: {
        findMany: async ({ cursor }: { cursor?: { id: string } }) => (cursor ? [] : rows.map((r) => ({ ...r }))),
        update: async ({ where, data }: { where: { id: string }; data: { titleEnc: string; notesEnc: string | null } }) => {
          Object.assign(rows.find((r) => r.id === where.id)!, data);
        },
      },
    };
    const cipher = new PersonalCipher([NEW, OLD]);
    const first = await rekeyPersonalTasks(prisma as never, cipher, () => undefined);
    expect(first).toEqual({ scanned: 3, rekeyed: 1, failed: 1 });
    expect(new PersonalCipher([NEW]).decrypt(rows[0]!.titleEnc, 'u').plain).toBe('a');
    expect(new PersonalCipher([NEW]).decrypt(rows[0]!.notesEnc!, 'u').plain).toBe('n');
    const second = await rekeyPersonalTasks(prisma as never, cipher, () => undefined);
    expect(second.rekeyed).toBe(0);
  });
});
