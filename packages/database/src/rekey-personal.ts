/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { PersonalCipher } from './personal-cipher';

/**
 * One-off key rotation for personal tasks (run as an ECS one-off task in the API image):
 *   PERSONAL_DATA_KEY=<new> PERSONAL_DATA_KEY_PREVIOUS=<old> node packages/database/dist/rekey-personal.js
 * Re-encrypts every row still encrypted with the previous key, in batches, idempotently (rows
 * already on the new key are left untouched). Prints counts only — never content or keys.
 * Exit code 1 if any row cannot be decrypted with either key (nothing is overwritten for it).
 */
export async function rekeyPersonalTasks(prisma: PrismaClient, cipher: PersonalCipher, log: (m: string) => void = console.log) {
  let cursor: string | undefined;
  let scanned = 0;
  let rekeyed = 0;
  let failed = 0;
  for (;;) {
    const rows = await prisma.personalTask.findMany({ take: 200, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: 'asc' } });
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned++;
      try {
        const title = cipher.decrypt(r.titleEnc, r.ownerId);
        const notes = r.notesEnc ? cipher.decrypt(r.notesEnc, r.ownerId) : null;
        if (!title.stale && !notes?.stale) continue;
        await prisma.personalTask.update({
          where: { id: r.id },
          data: { titleEnc: cipher.encrypt(title.plain, r.ownerId), notesEnc: notes ? cipher.encrypt(notes.plain, r.ownerId) : null },
        });
        rekeyed++;
      } catch {
        failed++;
      }
    }
    cursor = rows.at(-1)!.id;
  }
  log(`personal tasks: scanned ${scanned}, re-encrypted ${rekeyed}, undecryptable ${failed}`);
  return { scanned, rekeyed, failed };
}

if (require.main === module) {
  const current = process.env.PERSONAL_DATA_KEY;
  const previous = process.env.PERSONAL_DATA_KEY_PREVIOUS;
  if (!current || current.length < 32 || !previous || previous.length < 32 || current === previous) {
    console.error('Set PERSONAL_DATA_KEY (new) and PERSONAL_DATA_KEY_PREVIOUS (old), both >= 32 characters and different.');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  rekeyPersonalTasks(prisma, new PersonalCipher([current, previous]))
    .then((r) => process.exit(r.failed > 0 ? 1 : 0))
    .catch((e) => {
      console.error(`rekey failed: ${(e as Error).name}`);
      process.exit(1);
    })
    .finally(() => void prisma.$disconnect());
}
