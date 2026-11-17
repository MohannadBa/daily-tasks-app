/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { PersonalCipher } from './personal-cipher';

/**
 * Target guard for drills (R3): with VERIFY_RESTORE_EXPECT_HOST set, the verifier refuses to run unless
 * DB_HOST_OVERRIDE equals that host AND the connection URL actually points at it — so a broken or empty
 * override can never make a drill read the production database (which would also be a false "pass").
 * Returns an error message, or null when the target is acceptable.
 */
export function drillTargetError(env: Record<string, string | undefined>): string | null {
  const expected = env.VERIFY_RESTORE_EXPECT_HOST?.trim().toLowerCase();
  if (!expected) return null; // not a drill (e.g. checking a real recovery explicitly)
  const override = env.DB_HOST_OVERRIDE?.trim().toLowerCase();
  let host = '';
  try {
    host = new URL(env.DATABASE_URL ?? '').hostname.toLowerCase();
  } catch {
    /* invalid URL */
  }
  if (!override) return 'DB_HOST_OVERRIDE is empty — refusing (the connection would fall back to the production host)';
  if (override !== expected) return `DB_HOST_OVERRIDE (${override}) is not the expected drill host (${expected})`;
  if (host !== expected) return `the connection URL points at ${host || 'nothing'}, not the drill host ${expected}`;
  return null;
}

export interface RestoreReport {
  migrationsApplied: number;
  counts: Record<string, number>;
  personal: { checked: number; undecryptable: number };
  ok: boolean;
}

/**
 * READ-ONLY verification of a restored database (restore drill / real recovery). Run as a one-off
 * task of the API task definition (it has PERSONAL_DATA_KEY) with DB_HOST_OVERRIDE=<restored endpoint>:
 * checks the migration history, counts the main tables and decrypts every personal task with the
 * key(s) the API holds — proving that backups are usable together with the current key.
 * Prints counts only: never content, e-mail addresses or keys. Exit 1 when anything is wrong.
 */
export async function verifyRestore(prisma: PrismaClient, cipher: PersonalCipher): Promise<RestoreReport> {
  const migrations = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  const counts = {
    companies: await prisma.company.count(),
    users: await prisma.user.count(),
    activeAdmins: await prisma.user.count({ where: { role: 'ADMIN', isActive: true } }),
    projects: await prisma.project.count(),
    tasks: await prisma.task.count(),
    attachments: await prisma.taskAttachment.count(),
    documents: await prisma.projectDocument.count(),
    auditEntries: await prisma.auditLog.count(),
  };
  let checked = 0;
  let undecryptable = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.personalTask.findMany({ take: 500, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: 'asc' }, select: { id: true, ownerId: true, titleEnc: true, notesEnc: true } });
    if (rows.length === 0) break;
    for (const r of rows) {
      checked++;
      try {
        cipher.decrypt(r.titleEnc, r.ownerId);
        if (r.notesEnc) cipher.decrypt(r.notesEnc, r.ownerId);
      } catch {
        undecryptable++;
      }
    }
    cursor = rows.at(-1)!.id;
  }
  const migrationsApplied = Number(migrations[0]?.n ?? 0);
  const ok = migrationsApplied > 0 && counts.companies > 0 && counts.activeAdmins > 0 && undecryptable === 0;
  return { migrationsApplied, counts, personal: { checked, undecryptable }, ok };
}

if (require.main === module) {
  const key = process.env.PERSONAL_DATA_KEY;
  if (!key || key.length < 32) {
    console.error('PERSONAL_DATA_KEY is required (run with the API task definition).');
    process.exit(2);
  }
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').hostname;
    } catch {
      return 'unknown';
    }
  })();
  const targetError = drillTargetError(process.env);
  if (targetError) {
    console.error(`verify-restore: REFUSED — ${targetError}`);
    process.exit(4);
  }
  const prisma = new PrismaClient();
  verifyRestore(prisma, new PersonalCipher([key, process.env.PERSONAL_DATA_KEY_PREVIOUS]))
    .then((r) => {
      console.log(`verify-restore: host ${host}`);
      console.log(`verify-restore: migrations applied ${r.migrationsApplied}`);
      console.log(`verify-restore: counts ${JSON.stringify(r.counts)}`);
      console.log(`verify-restore: personal tasks checked ${r.personal.checked}, undecryptable ${r.personal.undecryptable}`);
      console.log(`verify-restore: ${r.ok ? 'OK' : 'FAILED'}`);
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((e) => {
      console.error(`verify-restore failed: ${(e as Error).name}`);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
