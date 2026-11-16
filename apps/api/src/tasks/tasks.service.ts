import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { OutboxEventType, Prisma, TaskHistoryAction, TaskStatus, UserRole } from '@dailytasks/database';
import type { Paginated, TaskCommentDto, TaskDetailDto, TaskDto, TaskHistoryDto } from '@dailytasks/shared-types';
import type { completeTaskSchema, createCommentSchema, createTaskSchema, reopenTaskSchema, taskListQuerySchema, updateTaskSchema, z } from '@dailytasks/validation';
import { AccessService, type TaskAccess } from '../access/access.service';
import { AttachmentsService, toAttachmentDto } from '../attachments/attachments.service';
import type { AuthUser } from '../auth/auth.types';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { taskInclude, toTaskDto } from './task.mapper';

/** Small allowance for client clock skew when validating "deadline must be in the future". */
const DEADLINE_SKEW_MS = 60_000;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly outbox: OutboxService,
    private readonly attachments: AttachmentsService,
  ) {}

  /* ------------------------------ queries ------------------------------ */

  async list(user: AuthUser, q: z.infer<typeof taskListQuerySchema>): Promise<Paginated<TaskDto>> {
    const now = new Date();
    const and: Prisma.TaskWhereInput[] = [this.access.taskScope(user), { archivedAt: null }];
    if (q.projectId) and.push({ projectId: q.projectId });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId });
    if (q.status) and.push({ status: q.status });
    if (q.q) and.push({ OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] });
    switch (q.view) {
      case 'active':
        and.push({ status: { not: TaskStatus.COMPLETED } });
        break;
      case 'completed':
        and.push({ status: TaskStatus.COMPLETED });
        break;
      case 'overdue':
        and.push({ status: { not: TaskStatus.COMPLETED }, deadline: { lt: now } });
        break;
      case 'awaiting_rating': {
        if (user.role === UserRole.EMPLOYEE) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
        and.push({ id: { in: await this.awaitingRatingIds() } });
        // Only tasks the caller can actually rate (managers of the project / admins).
        and.push(this.managerOnlyScope(user));
        break;
      }
    }
    const where: Prisma.TaskWhereInput = { AND: and };
    const sorts: Record<NonNullable<typeof q.sort>, Prisma.TaskOrderByWithRelationInput[]> = {
      deadline: [{ deadline: 'asc' }],
      '-deadline': [{ deadline: 'desc' }],
      '-created': [{ createdAt: 'desc' }],
      '-updated': [{ updatedAt: 'desc' }],
      title: [{ title: 'asc' }],
    };
    const orderBy: Prisma.TaskOrderByWithRelationInput[] = [
      ...(q.sort ? sorts[q.sort] : q.view === 'completed' || q.view === 'awaiting_rating' ? [{ completedAt: 'desc' as const }] : [{ deadline: 'asc' as const }]),
      { id: 'asc' }, // stable pagination
    ];
    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({ where, include: taskInclude, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.task.count({ where }),
    ]);
    const managed = await this.managedSet(user);
    return {
      items: rows.map((t) => toTaskDto(t, managed === 'ALL' || managed.has(t.projectId))),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async get(user: AuthUser, taskId: string): Promise<TaskDetailDto> {
    const { access } = await this.access.taskAccess(user, taskId);
    return this.detail(taskId, access);
  }

  async comments(user: AuthUser, taskId: string): Promise<TaskCommentDto[]> {
    await this.access.taskAccess(user, taskId);
    const rows = await this.prisma.taskComment.findMany({
      where: { taskId },
      include: { author: true, attachments: { where: { status: 'UPLOADED' }, include: { uploadedBy: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => ({
      id: c.id,
      body: c.body,
      isCompletionNote: c.isCompletionNote,
      author: { id: c.author.id, name: c.author.name, email: c.author.email },
      attachments: c.attachments.map(toAttachmentDto),
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async history(user: AuthUser, taskId: string): Promise<TaskHistoryDto[]> {
    await this.access.taskAccess(user, taskId);
    const rows = await this.prisma.taskHistory.findMany({ where: { taskId }, include: { actor: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((h) => ({
      id: h.id,
      action: h.action,
      actor: h.actor ? { id: h.actor.id, name: h.actor.name, email: h.actor.email } : null,
      metadata: (h.metadata ?? {}) as Record<string, unknown>,
      createdAt: h.createdAt.toISOString(),
    }));
  }

  /* ------------------------------ commands ----------------------------- */

  async create(user: AuthUser, input: z.infer<typeof createTaskSchema>): Promise<TaskDetailDto> {
    const access = await this.access.assertProjectManager(user, input.projectId);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: input.projectId } });
    if (project.status !== 'ACTIVE') throw new BadRequestException('Project is archived');
    await this.access.assertAssignable(input.projectId, input.assigneeId);
    this.assertFutureDeadline(input.deadline);

    const task = await this.prisma.$transaction(async (tx) => {
      const t = await tx.task.create({
        data: {
          projectId: input.projectId,
          assigneeId: input.assigneeId,
          createdById: user.id,
          title: input.title,
          description: input.description,
          deadline: input.deadline,
          scheduleVersion: 1,
        },
      });
      await tx.taskHistory.create({
        data: { taskId: t.id, actorId: user.id, action: TaskHistoryAction.CREATED, metadata: { assigneeId: t.assigneeId, deadline: t.deadline.toISOString() } },
      });
      await this.outbox.taskEvent(tx, OutboxEventType.TASK_ASSIGNED, { taskId: t.id, projectId: t.projectId, actorId: user.id }, `TASK_ASSIGNED:${t.id}`);
      await this.outbox.scheduleSync(tx, t.id, t.scheduleVersion);
      return t;
    });
    return this.detail(task.id, access === 'ADMIN' ? 'ADMIN' : 'MANAGER');
  }

  async update(user: AuthUser, taskId: string, input: z.infer<typeof updateTaskSchema>): Promise<TaskDetailDto> {
    const { task, access } = await this.access.assertTaskManager(user, taskId);
    if (task.status === TaskStatus.COMPLETED) throw new ConflictException('Reopen the task before editing it');
    const deadlineChanged = input.deadline !== undefined && input.deadline.getTime() !== task.deadline.getTime();
    if (deadlineChanged) this.assertFutureDeadline(input.deadline!);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.title !== undefined && input.title !== task.title) changes.title = { from: task.title, to: input.title };
    if (input.description !== undefined && input.description !== task.description) changes.description = { from: '…', to: '…' };
    if (deadlineChanged) changes.deadline = { from: task.deadline.toISOString(), to: input.deadline!.toISOString() };
    if (Object.keys(changes).length === 0) return this.detail(taskId, access);

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: taskId },
        data: {
          title: input.title,
          description: input.description,
          deadline: input.deadline,
          ...(deadlineChanged ? { scheduleVersion: { increment: 1 } } : {}),
        },
      });
      const h = await tx.taskHistory.create({
        data: {
          taskId,
          actorId: user.id,
          action: deadlineChanged ? TaskHistoryAction.DEADLINE_CHANGED : TaskHistoryAction.UPDATED,
          metadata: changes as Prisma.InputJsonValue,
        },
      });
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_UPDATED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { fields: Object.keys(changes) } },
        `TASK_UPDATED:${h.id}`,
      );
      // New version => old scheduled reminders become no-ops; the worker creates new ones.
      if (deadlineChanged) await this.outbox.scheduleSync(tx, taskId, updated.scheduleVersion);
    });
    return this.detail(taskId, access);
  }

  async reassign(user: AuthUser, taskId: string, assigneeId: string): Promise<TaskDetailDto> {
    const { task, access } = await this.access.assertTaskManager(user, taskId);
    if (task.status === TaskStatus.COMPLETED) throw new ConflictException('Completed tasks cannot be reassigned; reopen first');
    if (assigneeId === task.assigneeId) throw new BadRequestException('Task is already assigned to this employee');
    await this.access.assertAssignable(task.projectId, assigneeId);

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.task.updateMany({
        where: { id: taskId, assigneeId: task.assigneeId, status: { not: TaskStatus.COMPLETED } },
        data: { assigneeId, status: TaskStatus.ASSIGNED, startedAt: null },
      });
      if (res.count !== 1) throw new ConflictException('Task changed concurrently, please retry');
      const h = await tx.taskHistory.create({
        data: { taskId, actorId: user.id, action: TaskHistoryAction.REASSIGNED, metadata: { from: task.assigneeId, to: assigneeId } },
      });
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_REASSIGNED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { previousAssigneeId: task.assigneeId, newAssigneeId: assigneeId } },
        `TASK_REASSIGNED:${h.id}`,
      );
    });
    return this.detail(taskId, access);
  }

  async start(user: AuthUser, taskId: string): Promise<TaskDetailDto> {
    const { task } = await this.access.assertTaskAssignee(user, taskId);
    if (task.status === TaskStatus.ASSIGNED) {
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.task.updateMany({
          where: { id: taskId, status: TaskStatus.ASSIGNED, assigneeId: user.id },
          data: { status: TaskStatus.IN_PROGRESS, startedAt: new Date() },
        });
        if (res.count === 1) await tx.taskHistory.create({ data: { taskId, actorId: user.id, action: TaskHistoryAction.STARTED } });
      });
    }
    return this.detail(taskId, 'ASSIGNEE');
  }

  async addComment(user: AuthUser, taskId: string, input: z.infer<typeof createCommentSchema>): Promise<TaskCommentDto> {
    const { task, access } = await this.access.taskAccess(user, taskId);
    const comment = await this.prisma.$transaction(async (tx) => {
      const c = await tx.taskComment.create({ data: { taskId, authorId: user.id, body: input.body } });
      await this.attachments.linkToComment(tx, user.id, taskId, c.id, input.attachmentIds);
      await tx.taskHistory.create({
        data: { taskId, actorId: user.id, action: TaskHistoryAction.COMMENTED, metadata: { commentId: c.id, attachments: input.attachmentIds.length } },
      });
      // An employee replying implies work has started.
      if (access === 'ASSIGNEE' && task.status === TaskStatus.ASSIGNED) {
        const res = await tx.task.updateMany({ where: { id: taskId, status: TaskStatus.ASSIGNED }, data: { status: TaskStatus.IN_PROGRESS, startedAt: new Date() } });
        if (res.count === 1) await tx.taskHistory.create({ data: { taskId, actorId: user.id, action: TaskHistoryAction.STARTED } });
      }
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_COMMENT_ADDED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { commentId: c.id, byAssignee: access === 'ASSIGNEE' } },
        `TASK_COMMENT_ADDED:${c.id}`,
      );
      return c;
    });
    return (await this.comments(user, taskId)).find((c) => c.id === comment.id)!;
  }

  /**
   * Completion is immediate (no approval). completedAt and completedLate are fixed here, inside the
   * transaction, so background processing delays can never turn an on-time completion into "overdue".
   */
  async complete(user: AuthUser, taskId: string, input: z.infer<typeof completeTaskSchema>): Promise<TaskDetailDto> {
    const { task } = await this.access.assertTaskAssignee(user, taskId);
    if (task.status === TaskStatus.COMPLETED) throw new ConflictException('Task is already completed');

    await this.prisma.$transaction(async (tx) => {
      const completedAt = new Date();
      const completedLate = completedAt.getTime() > task.deadline.getTime();
      // Conditional update guards against double submission and concurrent reassignment.
      const res = await tx.task.updateMany({
        where: { id: taskId, assigneeId: user.id, status: { in: [TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] } },
        data: {
          status: TaskStatus.COMPLETED,
          completedAt,
          completedLate,
          startedAt: task.startedAt ?? completedAt,
          scheduleVersion: { increment: 1 },
        },
      });
      if (res.count !== 1) throw new ConflictException('Task changed concurrently, please retry');
      const c = await tx.taskComment.create({ data: { taskId, authorId: user.id, body: input.comment, isCompletionNote: true } });
      await this.attachments.linkToComment(tx, user.id, taskId, c.id, input.attachmentIds);
      await tx.taskHistory.create({
        data: {
          taskId,
          actorId: user.id,
          action: TaskHistoryAction.COMPLETED,
          metadata: { commentId: c.id, completedLate, deadline: task.deadline.toISOString(), attachments: input.attachmentIds.length },
        },
      });
      const fresh = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_COMPLETED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { completedLate } },
        `TASK_COMPLETED:${taskId}:${fresh.reopenCount}`,
      );
      await this.outbox.scheduleSync(tx, taskId, fresh.scheduleVersion);
    });
    return this.detail(taskId, 'ASSIGNEE');
  }

  async reopen(user: AuthUser, taskId: string, input: z.infer<typeof reopenTaskSchema>): Promise<TaskDetailDto> {
    const { task, access } = await this.access.assertTaskManager(user, taskId);
    if (task.status !== TaskStatus.COMPLETED) throw new ConflictException('Only completed tasks can be reopened');
    if (input.deadline) this.assertFutureDeadline(input.deadline);

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.task.updateMany({
        where: { id: taskId, status: TaskStatus.COMPLETED },
        data: {
          status: TaskStatus.ASSIGNED,
          completedAt: null,
          completedLate: null,
          reopenCount: { increment: 1 },
          scheduleVersion: { increment: 1 },
          ...(input.deadline ? { deadline: input.deadline } : {}),
        },
      });
      if (res.count !== 1) throw new ConflictException('Task changed concurrently, please retry');
      // Previous completion facts are preserved permanently in history.
      await tx.taskHistory.create({
        data: {
          taskId,
          actorId: user.id,
          action: TaskHistoryAction.REOPENED,
          metadata: {
            reason: input.reason,
            previousCompletedAt: task.completedAt?.toISOString() ?? null,
            previousCompletedLate: task.completedLate,
            previousDeadline: task.deadline.toISOString(),
            newDeadline: input.deadline?.toISOString() ?? null,
          },
        },
      });
      const fresh = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_REOPENED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { reason: input.reason } },
        `TASK_REOPENED:${taskId}:${fresh.reopenCount}`,
      );
      await this.outbox.scheduleSync(tx, taskId, fresh.scheduleVersion);
    });
    return this.detail(taskId, access);
  }

  /* ------------------------------ helpers ------------------------------ */

  private assertFutureDeadline(deadline: Date) {
    if (deadline.getTime() < Date.now() - DEADLINE_SKEW_MS) throw new BadRequestException('Deadline must be in the future');
  }

  private async detail(taskId: string, access: TaskAccess): Promise<TaskDetailDto> {
    const t = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
    const isManager = access !== 'ASSIGNEE';
    const instructionFiles = await this.prisma.taskAttachment.findMany({
      where: { taskId, status: 'UPLOADED', commentId: null, uploadedById: { not: t.assigneeId } },
      include: { uploadedBy: true },
      orderBy: { createdAt: 'asc' },
    });
    const open = t.status !== TaskStatus.COMPLETED;
    return {
      ...toTaskDto(t, isManager),
      attachments: instructionFiles.map(toAttachmentDto),
      permissions: {
        canEdit: isManager && open,
        canComment: true,
        canComplete: access === 'ASSIGNEE' && open,
        canStart: access === 'ASSIGNEE' && t.status === TaskStatus.ASSIGNED,
        canReopen: isManager && !open,
        canRate: isManager && !open,
      },
    };
  }

  private async awaitingRatingIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t."id" FROM "Task" t
      LEFT JOIN "TaskRating" r ON r."taskId" = t."id"
      WHERE t."status" = 'COMPLETED' AND t."archivedAt" IS NULL
        AND (r."id" IS NULL OR r."updatedAt" < t."completedAt")`;
    return rows.map((r) => r.id);
  }

  private managerOnlyScope(user: AuthUser): Prisma.TaskWhereInput {
    if (this.access.isAdmin(user)) return { project: { companyId: user.companyId } };
    return { project: { memberships: { some: { userId: user.id, role: 'MANAGER', removedAt: null } } } };
  }

  private async managedSet(user: AuthUser): Promise<'ALL' | Set<string>> {
    const ids = await this.access.managedProjectIds(user);
    return ids === null ? 'ALL' : new Set(ids);
  }
}
