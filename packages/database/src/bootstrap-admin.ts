/* eslint-disable no-console */
import { PrismaClient, UserRole } from '@prisma/client';
import { ensureCompanyDefaults } from './ledger-backfill';

export interface BootstrapInput {
  companyName: string;
  adminEmail: string;
  adminName: string;
  locale?: 'ar' | 'en';
}

/**
 * First-time setup of an empty environment (replaces hand-written SQL): creates the company with
 * its default departments and document categories, and the first ADMIN user row flagged to change
 * the temporary password. The login itself is created in Cognito separately
 * (`aws cognito-idp admin-create-user`, which e-mails the temporary password — see docs/STAGING_PLAN.md).
 * Refuses to run when any ADMIN already exists (it is not a way to add admins later).
 */
export async function bootstrapAdmin(prisma: PrismaClient, input: BootstrapInput): Promise<{ companyId: string; userId: string }> {
  const email = input.adminEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid e-mail address');
  if (!input.companyName.trim() || !input.adminName.trim()) throw new Error('Company and admin names are required');
  if ((await prisma.user.count({ where: { role: UserRole.ADMIN } })) > 0) throw new Error('An admin already exists — refusing to bootstrap again');
  return prisma.$transaction(async (tx) => {
    const company = (await tx.company.findFirst()) ?? (await tx.company.create({ data: { name: input.companyName.trim() } }));
    const user = await tx.user.create({
      data: { companyId: company.id, email, name: input.adminName.trim(), role: UserRole.ADMIN, locale: input.locale ?? 'ar', mustChangePassword: true },
    });
    await tx.auditLog.create({ data: { companyId: company.id, actorId: null, action: 'USER_CREATED', entityType: 'USER', entityId: user.id, metadata: { role: 'ADMIN', via: 'bootstrap' } } });
    await ensureCompanyDefaults(tx as unknown as PrismaClient, company.id);
    return { companyId: company.id, userId: user.id };
  });
}

if (require.main === module) {
  const input: BootstrapInput = {
    companyName: process.env.BOOTSTRAP_COMPANY_NAME ?? '',
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    adminName: process.env.BOOTSTRAP_ADMIN_NAME ?? '',
    locale: process.env.BOOTSTRAP_ADMIN_LOCALE === 'en' ? 'en' : 'ar',
  };
  const prisma = new PrismaClient();
  bootstrapAdmin(prisma, input)
    .then((r) => console.log(`bootstrap: company ${r.companyId}, admin user ${r.userId} created`))
    .catch((e) => {
      console.error(`bootstrap refused: ${(e as Error).message}`);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
