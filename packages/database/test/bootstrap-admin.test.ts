import { describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/bootstrap-admin';

function fakePrisma(existingAdmins = 0) {
  const db = { companies: [] as Array<{ id: string; name: string }>, users: [] as Array<Record<string, unknown>>, audit: [] as unknown[], departments: 0, categories: 0 };
  const tx = {
    company: { findFirst: async () => db.companies[0] ?? null, create: async ({ data }: { data: { name: string } }) => (db.companies.push({ id: 'c1', ...data }), db.companies[0]) },
    user: { create: async ({ data }: { data: Record<string, unknown> }) => (db.users.push({ id: 'u1', ...data }), { id: 'u1', ...data }) },
    auditLog: { create: async ({ data }: { data: unknown }) => db.audit.push(data) },
    department: { createMany: async ({ data }: { data: unknown[] }) => ((db.departments += data.length), { count: data.length }) },
    documentCategory: { createMany: async ({ data }: { data: unknown[] }) => ((db.categories += data.length), { count: data.length }) },
  };
  const prisma = { user: { count: async () => existingAdmins }, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { prisma: prisma as never, db };
}

describe('bootstrapAdmin (first-time setup without hand-written SQL)', () => {
  it('creates the company with default departments/categories and an ADMIN who must change the temporary password', async () => {
    const { prisma, db } = fakePrisma();
    const r = await bootstrapAdmin(prisma, { companyName: ' شركة الراسيات ', adminEmail: ' Admin@Example.COM ', adminName: 'Amal' });
    expect(r).toEqual({ companyId: 'c1', userId: 'u1' });
    expect(db.companies[0]!.name).toBe('شركة الراسيات');
    expect(db.users[0]).toMatchObject({ email: 'admin@example.com', role: 'ADMIN', mustChangePassword: true, locale: 'ar' });
    expect(db.departments).toBe(7);
    expect(db.categories).toBeGreaterThan(0);
    expect(db.audit).toHaveLength(1);
    expect(JSON.stringify(db.users[0])).not.toMatch(/password"\s*:\s*"/i); // no password stored here (Cognito holds it)
  });

  it('refuses when an admin already exists, and validates input', async () => {
    await expect(bootstrapAdmin(fakePrisma(1).prisma, { companyName: 'X', adminEmail: 'a@b.co', adminName: 'A' })).rejects.toThrow('already exists');
    await expect(bootstrapAdmin(fakePrisma().prisma, { companyName: 'X', adminEmail: 'not-an-email', adminName: 'A' })).rejects.toThrow('valid e-mail');
    await expect(bootstrapAdmin(fakePrisma().prisma, { companyName: ' ', adminEmail: 'a@b.co', adminName: 'A' })).rejects.toThrow('required');
  });
});
