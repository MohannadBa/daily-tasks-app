import { Prisma, type PrismaClient } from '@prisma/client';
import { computeCycle, type LedgerSegment } from './time-ledger';

/** Default departments and document categories for a company (idempotent). */
export const DEFAULT_DEPARTMENTS = [
  { code: 'PROJECT_MANAGEMENT', nameAr: 'إدارة المشاريع', nameEn: 'Project Management' },
  { code: 'MARKETING', nameAr: 'التسويق', nameEn: 'Marketing' },
  { code: 'FINANCE', nameAr: 'المالية', nameEn: 'Finance' },
  { code: 'ENGINEERING_OFFICES', nameAr: 'المكاتب الهندسية', nameEn: 'Engineering Offices' },
  { code: 'HUMAN_RESOURCES', nameAr: 'الموارد البشرية', nameEn: 'Human Resources' },
  { code: 'CONTRACTS', nameAr: 'العقود', nameEn: 'Contracts' },
  { code: 'LEGAL_AFFAIRS', nameAr: 'الشؤون القانونية', nameEn: 'Legal Affairs' },
] as const;

export const DEFAULT_DOCUMENT_CATEGORIES = [
  { code: 'CONTRACTS', nameAr: 'العقود', nameEn: 'Contracts' },
  { code: 'DRAWINGS', nameAr: 'المخططات', nameEn: 'Drawings' },
  { code: 'REPORTS', nameAr: 'التقارير', nameEn: 'Reports' },
  { code: 'INVOICES', nameAr: 'الفواتير', nameEn: 'Invoices' },
  { code: 'PHOTOS', nameAr: 'الصور', nameEn: 'Photos' },
  { code: 'CORRESPONDENCE', nameAr: 'المراسلات', nameEn: 'Correspondence' },
  { code: 'COMPLETION', nameAr: 'مخرجات المهام', nameEn: 'Task deliverables' },
  { code: 'OTHER', nameAr: 'أخرى', nameEn: 'Other' },
] as const;

export async function ensureCompanyDefaults(prisma: PrismaClient, companyId: string): Promise<void> {
  await prisma.department.createMany({
    data: DEFAULT_DEPARTMENTS.map((d, i) => ({ companyId, ...d, sortOrder: i + 1 })),
    skipDuplicates: true,
  });
  await prisma.documentCategory.createMany({
    data: DEFAULT_DOCUMENT_CATEGORIES.map((d, i) => ({ companyId, ...d, sortOrder: i + 1 })),
    skipDuplicates: true,
  });
}

type Tx = Prisma.TransactionClient;

interface BuiltSegment extends LedgerSegment {
  cycleNo: number;
}

/**
 * Rebuilds the ledger of one pre-ledger task from its TaskHistory (idempotent: no-op when the
 * task already has cycles). Rules for legacy data:
 *  - completion used to be immediate, so each completion becomes an APPROVED submission with a
 *    zero-length approved review (`decisionReason = 'legacy auto-approval'`);
 *  - the stored `completedLate` stays authoritative for legacy cycles;
 *  - every row is tagged source = BACKFILL.
 */
export async function backfillTaskLedger(tx: Tx, taskId: string): Promise<boolean> {
  if (await tx.taskCycle.count({ where: { taskId } })) return false;
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  const events = await tx.taskHistory.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
  const completionComments = await tx.taskComment.findMany({ where: { taskId, isCompletionNote: true }, orderBy: { createdAt: 'asc' } });

  const created = events.find((e) => e.action === 'CREATED');
  const meta = (e: { metadata: Prisma.JsonValue }) => (e.metadata ?? {}) as Record<string, unknown>;
  const start0 = new Date(Math.min(task.createdAt.getTime(), ...events.map((e) => e.createdAt.getTime())));

  interface Cycle {
    cycleNo: number;
    startedAt: Date;
    originalDeadline: Date;
    approvedDeadline: Date;
    reopenReason: string | null;
    reopenedById: string | null;
    completedAt: Date | null;
    completedLate: boolean | null;
    approvedCommentId: string | null;
    approvedBy: string | null;
  }
  const cycles: Cycle[] = [];
  const segments: BuiltSegment[] = [];
  let assignee = (created && typeof meta(created).assigneeId === 'string' ? (meta(created).assigneeId as string) : null) ?? task.assigneeId;
  let cur: Cycle = {
    cycleNo: 1,
    startedAt: start0,
    originalDeadline: task.originalDeadline,
    approvedDeadline: task.originalDeadline,
    reopenReason: null,
    reopenedById: null,
    completedAt: null,
    completedLate: null,
    approvedCommentId: null,
    approvedBy: null,
  };
  cycles.push(cur);
  let openStart: Date | null = start0;

  const closeWork = (at: Date) => {
    if (!openStart) return;
    const end = at < openStart ? openStart : at;
    segments.push({ cycleNo: cur.cycleNo, kind: 'ACTIVE_WORK', startedAt: openStart, endedAt: end, charged: true, chargedToUserId: assignee, responsibleUserId: assignee });
    openStart = end;
  };

  for (const e of events) {
    const m = meta(e);
    if (e.action === 'REASSIGNED' && typeof m.to === 'string') {
      closeWork(e.createdAt);
      assignee = m.to;
    } else if (e.action === 'DEADLINE_CHANGED') {
      const to = (m.deadline as { to?: string } | undefined)?.to;
      if (to) cur.approvedDeadline = new Date(to);
    } else if (e.action === 'COMPLETED' && openStart) {
      closeWork(e.createdAt);
      segments.push({ cycleNo: cur.cycleNo, kind: 'APPROVED_REVIEW', startedAt: e.createdAt, endedAt: e.createdAt, charged: false, chargedToUserId: null, responsibleUserId: null });
      cur.completedAt = e.createdAt;
      cur.completedLate = typeof m.completedLate === 'boolean' ? m.completedLate : null;
      cur.approvedCommentId = typeof m.commentId === 'string' ? m.commentId : (completionComments.find((c) => Math.abs(c.createdAt.getTime() - e.createdAt.getTime()) < 5_000)?.id ?? null);
      openStart = null;
    } else if (e.action === 'REOPENED') {
      const deadline = typeof m.newDeadline === 'string' ? new Date(m.newDeadline) : typeof m.previousDeadline === 'string' ? new Date(m.previousDeadline) : task.deadline;
      cur = {
        cycleNo: cur.cycleNo + 1,
        startedAt: e.createdAt,
        originalDeadline: deadline,
        approvedDeadline: deadline,
        reopenReason: typeof m.reason === 'string' ? m.reason : null,
        reopenedById: e.actorId,
        completedAt: null,
        completedLate: null,
        approvedCommentId: null,
        approvedBy: null,
      };
      cycles.push(cur);
      openStart = e.createdAt;
    }
  }
  // Completed task whose completion is not in history (e.g. old seed data): close at completedAt.
  if (task.status === 'COMPLETED' && !cur.completedAt && task.completedAt) {
    closeWork(task.completedAt);
    segments.push({ cycleNo: cur.cycleNo, kind: 'APPROVED_REVIEW', startedAt: task.completedAt, endedAt: task.completedAt, charged: false, chargedToUserId: null, responsibleUserId: null });
    cur.completedAt = task.completedAt;
    cur.completedLate = task.completedLate;
    cur.approvedCommentId = completionComments.at(-1)?.id ?? null;
    openStart = null;
  }
  if (task.status === 'COMPLETED') cur.approvedDeadline = task.deadline;
  if (task.status !== 'COMPLETED' && cur.approvedDeadline.getTime() !== task.deadline.getTime()) cur.approvedDeadline = task.deadline;

  const usedComments = new Set<string>();
  for (const c of cycles) {
    const cyc = await tx.taskCycle.create({
      data: {
        taskId,
        cycleNo: c.cycleNo,
        startedAt: c.startedAt,
        originalDeadline: c.originalDeadline,
        approvedDeadline: c.approvedDeadline,
        reopenReason: c.reopenReason,
        reopenedById: c.reopenedById,
        source: 'BACKFILL',
      },
    });
    const own = segments.filter((s) => s.cycleNo === c.cycleNo);
    for (const s of own) {
      await tx.taskTimeSegment.create({
        data: {
          taskId,
          cycleId: cyc.id,
          kind: s.kind,
          responsibleUserId: s.responsibleUserId,
          chargedToUserId: s.charged ? s.chargedToUserId : null,
          charged: s.charged,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          closeReason: 'backfill',
          source: 'BACKFILL',
        },
      });
    }
    const budgetMs = Math.max(0, c.approvedDeadline.getTime() - c.startedAt.getTime());
    if (c.completedAt) {
      const comp = computeCycle(own, budgetMs, c.completedAt);
      if (c.approvedCommentId && !usedComments.has(c.approvedCommentId)) {
        usedComments.add(c.approvedCommentId);
        const comment = await tx.taskComment.findUnique({ where: { id: c.approvedCommentId } });
        if (comment) {
          await tx.taskSubmission.create({
            data: {
              taskId,
              cycleId: cyc.id,
              submittedById: comment.authorId,
              commentId: comment.id,
              stage: 'MANAGER',
              reviewerId: task.approverId,
              status: 'APPROVED',
              decidedAt: c.completedAt,
              decisionReason: 'legacy auto-approval',
              createdAt: comment.createdAt,
            },
          });
        }
      }
      await tx.taskCycle.update({
        where: { id: cyc.id },
        data: {
          completedAt: c.completedAt,
          accountableMs: BigInt(comp.accountableMs),
          budgetMs: BigInt(budgetMs),
          lateMs: BigInt(comp.overdueMs),
          completedLate: c.completedLate ?? comp.overdue,
        },
      });
    }
  }

  // Open work segment + denormalised state for the current cycle.
  const lastCycle = await tx.taskCycle.findFirstOrThrow({ where: { taskId }, orderBy: { cycleNo: 'desc' } });
  const closed = segments.filter((s) => s.cycleNo === lastCycle.cycleNo && s.charged).reduce((sum, s) => sum + (s.endedAt!.getTime() - s.startedAt.getTime()), 0);
  const budgetMs = Math.max(0, lastCycle.approvedDeadline.getTime() - lastCycle.startedAt.getTime());
  let clockRunningSince: Date | null = null;
  if (task.status !== 'COMPLETED' && openStart) {
    await tx.taskTimeSegment.create({
      data: { taskId, cycleId: lastCycle.id, kind: 'ACTIVE_WORK', responsibleUserId: task.assigneeId, startedAt: openStart, source: 'BACKFILL' },
    });
    clockRunningSince = openStart;
  }
  await tx.task.update({
    where: { id: taskId },
    data: {
      currentCycle: lastCycle.cycleNo,
      budgetMs: BigInt(budgetMs),
      chargedMs: BigInt(closed),
      clockRunningSince,
      effectiveDueAt: clockRunningSince ? new Date(clockRunningSince.getTime() + (budgetMs - closed)) : null,
    },
  });
  return true;
}

/** Backfills every task without a ledger. Each task in its own transaction; safe to re-run. */
export async function backfillAllLedgers(prisma: PrismaClient, log: (msg: string) => void = () => undefined): Promise<number> {
  const companies = await prisma.company.findMany({ select: { id: true } });
  for (const c of companies) await ensureCompanyDefaults(prisma, c.id);
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`SELECT t."id" FROM "Task" t WHERE NOT EXISTS (SELECT 1 FROM "TaskCycle" c WHERE c."taskId" = t."id")`;
  let n = 0;
  for (const { id } of ids) {
    if (await prisma.$transaction((tx) => backfillTaskLedger(tx, id))) n++;
  }
  log(`ledger backfill: ${n} task(s) migrated`);
  return n;
}

/** Consistency check used after backfill and by the nightly job. Returns human-readable problems. */
export async function verifyLedgers(prisma: PrismaClient): Promise<string[]> {
  const problems: string[] = [];
  const noCycle = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint n FROM "Task" t WHERE NOT EXISTS (SELECT 1 FROM "TaskCycle" c WHERE c."taskId" = t."id")`;
  if (Number(noCycle[0]?.n) > 0) problems.push(`${noCycle[0]!.n} task(s) without a cycle`);
  const openMismatch = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t."id" FROM "Task" t
    WHERE (t."status" <> 'COMPLETED') <> EXISTS (SELECT 1 FROM "TaskTimeSegment" s WHERE s."taskId" = t."id" AND s."endedAt" IS NULL)`;
  if (openMismatch.length) problems.push(`${openMismatch.length} task(s) with an inconsistent open segment`);
  const chargedMismatch = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t."id" FROM "Task" t JOIN "TaskCycle" c ON c."taskId" = t."id" AND c."cycleNo" = t."currentCycle"
    WHERE t."chargedMs" <> COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (s."endedAt" - s."startedAt")) * 1000)::bigint FROM "TaskTimeSegment" s
      WHERE s."cycleId" = c."id" AND s."charged"), 0)`;
  if (chargedMismatch.length) problems.push(`${chargedMismatch.length} task(s) whose chargedMs does not match the ledger`);
  return problems;
}
