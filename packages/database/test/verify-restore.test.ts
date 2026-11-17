import { describe, expect, it } from 'vitest';
import { PersonalCipher } from '../src/personal-cipher';
import { drillTargetError, verifyRestore } from '../src/verify-restore';

const KEY = 'k'.repeat(40);
function fakePrisma(personal: Array<{ id: string; ownerId: string; titleEnc: string; notesEnc: string | null }>, admins = 1) {
  const count = (n: number) => ({ count: async () => n });
  return {
    $queryRaw: async () => [{ n: 42n }],
    company: count(1),
    user: { count: async (a?: { where?: { role?: string } }) => (a?.where?.role === 'ADMIN' ? admins : 5) },
    project: count(2),
    task: count(10),
    taskAttachment: count(3),
    projectDocument: count(4),
    auditLog: count(7),
    personalTask: {
      findMany: async ({ cursor }: { cursor?: { id: string } }) => (cursor ? [] : personal),
    },
  } as never;
}

describe('verifyRestore (read-only restore drill check)', () => {
  const cipher = new PersonalCipher([KEY]);
  it('passes when migrations, data and every personal task decrypt with the current key', async () => {
    const rows = [{ id: 'p1', ownerId: 'u1', titleEnc: cipher.encrypt('t', 'u1'), notesEnc: cipher.encrypt('n', 'u1') }];
    const r = await verifyRestore(fakePrisma(rows), cipher);
    expect(r).toMatchObject({ ok: true, migrationsApplied: 42, personal: { checked: 1, undecryptable: 0 } });
    expect(r.counts.tasks).toBe(10);
  });
  it('fails when a backup needs a key we no longer hold, or there is no active admin', async () => {
    const other = new PersonalCipher(['o'.repeat(40)]);
    const rows = [{ id: 'p1', ownerId: 'u1', titleEnc: other.encrypt('t', 'u1'), notesEnc: null }];
    expect((await verifyRestore(fakePrisma(rows), cipher)).ok).toBe(false);
    expect((await verifyRestore(fakePrisma([], 0), cipher)).ok).toBe(false);
  });
});

describe('drill target guard (R3)', () => {
  const DRILL = 'dailytasks-production-drill-11171200.abc123.eu-north-1.rds.amazonaws.com';
  const PROD = 'dailytasks-production-database1a2b3c.abc123.eu-north-1.rds.amazonaws.com';
  const url = (host: string) => `postgresql://u:p@${host}:5432/dailytasks?schema=public&sslmode=require`;

  it('accepts only a connection to the expected drill host', () => {
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL, DB_HOST_OVERRIDE: DRILL, DATABASE_URL: url(DRILL) })).toBeNull();
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL.toUpperCase(), DB_HOST_OVERRIDE: DRILL, DATABASE_URL: url(DRILL) })).toBeNull();
  });
  it('refuses an empty override (which would silently fall back to production)', () => {
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL, DB_HOST_OVERRIDE: '', DATABASE_URL: url(PROD) })).toMatch(/empty/);
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL, DATABASE_URL: url(PROD) })).toMatch(/empty/);
  });
  it('refuses a mismatched override or a connection that points elsewhere', () => {
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL, DB_HOST_OVERRIDE: PROD, DATABASE_URL: url(PROD) })).toMatch(/not the expected drill host/);
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL, DB_HOST_OVERRIDE: DRILL, DATABASE_URL: url(PROD) })).toMatch(/points at/);
    expect(drillTargetError({ VERIFY_RESTORE_EXPECT_HOST: DRILL, DB_HOST_OVERRIDE: DRILL, DATABASE_URL: 'garbage' })).toMatch(/points at nothing/);
  });
  it('is inactive outside drills (explicit verification of a real recovery)', () => {
    expect(drillTargetError({ DATABASE_URL: url(PROD) })).toBeNull();
  });
});
