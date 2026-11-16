import { Prisma, TaskStatus } from '@dailytasks/database';
import type { TaskDto } from '@dailytasks/shared-types';
import { taskTime } from '../workflow/time-ledger.service';

export const taskInclude = {
  project: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  approver: { select: { id: true, name: true, email: true } },
  department: { select: { id: true, nameAr: true, nameEn: true } },
  rating: { select: { stars: true, updatedAt: true } },
  cycles: { orderBy: { cycleNo: 'desc' }, take: 1, select: { accountableMs: true, budgetMs: true, lateMs: true } },
  _count: { select: { comments: true, attachments: { where: { status: 'UPLOADED' } } } },
} satisfies Prisma.TaskInclude;

export type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

/**
 * Overdue is derived from accountable time (time ledger), never from wall-clock deadline alone.
 * Prisma filter equivalent of `accountable(now) > budget` on the denormalised columns.
 */
export function overdueWhere(now: Date, budgetField: Prisma.TaskFieldRefs['budgetMs']): Prisma.TaskWhereInput {
  return {
    status: { not: TaskStatus.COMPLETED },
    OR: [
      // Clock running: overdue once the effective due time has passed.
      { clockRunningSince: { not: null }, effectiveDueAt: { lt: now } },
      // Paused (awaiting the approver): overdue only if the budget was already exceeded.
      { clockRunningSince: null, chargedMs: { gt: budgetField } },
    ],
  };
}

/**
 * @param includeRating  true only for admins/managers. Employees never receive rating data.
 */
export function toTaskDto(t: TaskWithRelations, includeRating: boolean, now = new Date()): TaskDto {
  const time = taskTime(t, t.cycles[0] ?? null, now);
  const dto: TaskDto = {
    id: t.id,
    projectId: t.projectId,
    projectName: t.project.name,
    title: t.title,
    description: t.description,
    deadline: t.deadline.toISOString(),
    status: t.status,
    assignee: t.assignee,
    createdBy: t.createdBy,
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    completedLate: t.completedLate,
    isOverdue: time.overdue,
    reopenCount: t.reopenCount,
    attachmentCount: t._count.attachments,
    commentCount: t._count.comments,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    department: t.department,
    priority: t.priority,
    approver: t.approver,
    originalDeadline: t.originalDeadline.toISOString(),
    currentCycle: t.currentCycle,
    time,
    pending: { submissionId: t.pendingSubmissionId, transferId: t.pendingTransferId, extensionId: t.pendingExtensionId },
  };
  if (includeRating) {
    dto.rating = t.rating
      ? {
          stars: t.rating.stars,
          ratedAt: t.rating.updatedAt.toISOString(),
          // The task was reopened and completed again after it was rated.
          needsReview: !!t.completedAt && t.rating.updatedAt < t.completedAt,
        }
      : null;
  }
  return dto;
}
