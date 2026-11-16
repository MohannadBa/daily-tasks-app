import { Prisma, TaskStatus } from '@dailytasks/database';
import type { TaskDto } from '@dailytasks/shared-types';

export const taskInclude = {
  project: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  rating: { select: { stars: true, updatedAt: true } },
  _count: { select: { comments: true, attachments: { where: { status: 'UPLOADED' } } } },
} satisfies Prisma.TaskInclude;

export type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export function isOverdue(t: { status: TaskStatus; deadline: Date }, now = new Date()): boolean {
  return t.status !== TaskStatus.COMPLETED && t.deadline.getTime() < now.getTime();
}

/**
 * @param includeRating  true only for admins/managers. Employees never receive rating data.
 */
export function toTaskDto(t: TaskWithRelations, includeRating: boolean): TaskDto {
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
    isOverdue: isOverdue(t),
    reopenCount: t.reopenCount,
    attachmentCount: t._count.attachments,
    commentCount: t._count.comments,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
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
