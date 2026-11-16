import type { PrismaClient } from '@dailytasks/database';

const H = 3600_000;

/** Required enterprise columns for a task created directly in tests (running clock, fresh cycle). */
export async function taskFields(prisma: PrismaClient, companyId: string, approverId: string, deadline: Date) {
  const code = `D${Math.random().toString(36).slice(2, 10).toUpperCase().replace(/[0-9]/g, 'X')}`;
  const dept = await prisma.department.create({ data: { companyId, code, nameAr: `إدارة ${code}`, nameEn: `Dept ${code}` } });
  const now = new Date();
  return {
    departmentId: dept.id,
    approverId,
    originalDeadline: deadline,
    budgetMs: BigInt(Math.max(0, deadline.getTime() - now.getTime())),
    chargedMs: BigInt(0),
    clockRunningSince: now,
    effectiveDueAt: deadline,
  };
}

/** Ledger state of an open task whose accountable time already exceeds its budget. */
export const overdueLedger = () => {
  const now = Date.now();
  return { budgetMs: BigInt(H), chargedMs: BigInt(H + 1000), clockRunningSince: new Date(now), effectiveDueAt: new Date(now - 1000), deadline: new Date(now - 1000) };
};
