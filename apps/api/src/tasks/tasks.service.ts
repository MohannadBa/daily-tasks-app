import { Injectable } from '@nestjs/common';
import { OutboxEventType, Prisma, TaskHistoryAction, TaskStatus, UserRole } from '@dailytasks/database';
import type { Paginated, TaskCommentDto, TaskDetailDto, TaskDto, TaskHistoryDto, TaskTimeLedgerDto } from '@dailytasks/shared-types';
import type { createCommentSchema, createTaskSchema, reopenTaskSchema, taskListQuerySchema, updateTaskSchema, z } from '@dailytasks/validation';
import { AccessService, type TaskAccess } from '../access/access.service';
import { AttachmentsService, toAttachmentDto } from '../attachments/attachments.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, conflict, ErrorCode, forbidden } from '../common/errors';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeLedgerService } from '../workflow/time-ledger.service';
import { WorkflowService } from '../workflow/workflow.service';
import { overdueWhere, taskInclude, toTaskDto } from './task.mapper';

/** Small allowance for client clock skew when validating "deadline must be in the future". */
const DEADLINE_SKEW_MS = 60_000;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly outbox: OutboxService,
    private readonly attachments: AttachmentsService,
    private readonly ledger: TimeLedgerService,
    private readonly workflow: WorkflowService,
  ) {}

  /* ------------------------------ queries ------------------------------ */

  async list(user: AuthUser, q: z.infer<typeof taskListQuerySchema>): Promise<Paginated<TaskDto>> {
    const now = new Date();
    const and: Prisma.TaskWhereInput[] = [this.access.taskScope(user), { archivedAt: null }];
    if (q.projectId) and.push({ projectId: q.projectId });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId });
    if (q.status) and.push({ status: q.status });
    if (q.departmentId) and.push({ departmentId: q.departmentId });
    if (q.priority) and.push({ priority: q.priority });
    if (q.q) and.push({ OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] });
    switch (q.view) {
      case 'active':
        and.push({ status: { not: TaskStatus.COMPLETED } });
        break;
      case 'pending_review':
        and.push({ status: TaskStatus.PENDING_REVIEW });
        break;
      case 'rejected':
        // My tasks sent back to me (rejected / returned) that I have not resubmitted yet.
        and.push({ assigneeId: user.id, status: TaskStatus.IN_PROGRESS, submissions: { some: { submittedById: user.id, status: { in: ['REJECTED', 'RETURNED'] } } } });
        break;
      case 'to_review':
        // Submissions waiting for me (as delegator or approver).
        and.push({ submissions: { some: { status: 'PENDING', reviewerId: user.id } } });
        break;
      case 'completed':
        and.push({ status: TaskStatus.COMPLETED });
        break;
      case 'overdue':
        and.push(overdueWhere(now, this.prisma.task.fields.budgetMs));
        break;
      case 'awaiting_rating': {
        if (user.role === UserRole.EMPLOYEE) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
        and.push({ id: { in: await this.awaitingRatingIds() } });
        // Only tasks the caller can actually rate: tasks they manage (created / approve), never their own.
        and.push(this.access.managedTaskScope(user), { assigneeId: { not: user.id } });
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
    return {
      items: rows.map((t) => toTaskDto(t, this.access.canSeeRating(user, t), now)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async get(user: AuthUser, taskId: string): Promise<TaskDetailDto> {
    const { access } = await this.access.taskAccess(user, taskId);
    return this.detail(taskId, access, user);
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
    if (project.status !== 'ACTIVE') throw badRequest(ErrorCode.INVALID_STATE, 'Project is archived');
    await this.access.assertDepartment(user, input.departmentId);
    await this.access.assertAssignable(input.projectId, input.assigneeId, input.departmentId);
    let approverId = user.id;
    if (input.approverId && input.approverId !== user.id) {
      if (!this.access.isAdmin(user)) throw forbidden('Only an admin can set another approver');
      await this.access.assertValidApprover(user.companyId, input.projectId, input.approverId);
      approverId = input.approverId;
    }
    this.assertFutureDeadline(input.deadline);
    if (input.assigneeId === user.id || input.assigneeId === approverId) {
      throw badRequest(ErrorCode.ASSIGNEE_NOT_ELIGIBLE, 'The person who creates or approves a task cannot be its assignee');
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const t = await tx.task.create({
        data: {
          projectId: input.projectId,
          departmentId: input.departmentId,
          assigneeId: input.assigneeId,
          createdById: user.id,
          approverId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          deadline: input.deadline,
          originalDeadline: input.deadline,
          scheduleVersion: 0,
        },
      });
      const cycle = await tx.taskCycle.create({
        data: { taskId: t.id, cycleNo: 1, startedAt: now, originalDeadline: input.deadline, approvedDeadline: input.deadline },
      });
      await tx.taskTimeSegment.create({ data: { taskId: t.id, cycleId: cycle.id, kind: 'ACTIVE_WORK', responsibleUserId: input.assigneeId, startedAt: now } });
      await tx.taskHistory.create({
        data: {
          taskId: t.id,
          actorId: user.id,
          action: TaskHistoryAction.CREATED,
          metadata: { assigneeId: t.assigneeId, deadline: t.deadline.toISOString(), departmentId: input.departmentId, priority: input.priority, approverId },
        },
      });
      await this.outbox.taskEvent(tx, OutboxEventType.TASK_ASSIGNED, { taskId: t.id, projectId: t.projectId, actorId: user.id }, `TASK_ASSIGNED:${t.id}`);
      await this.ledger.sync(tx, t.id);
      return t;
    });
    return this.detail(task.id, access === 'ADMIN' ? 'ADMIN' : 'MANAGER', user);
  }

  async update(user: AuthUser, taskId: string, input: z.infer<typeof updateTaskSchema>): Promise<TaskDetailDto> {
    const { task, access } = await this.access.assertTaskManager(user, taskId);
    if (task.status === TaskStatus.COMPLETED) throw conflict(ErrorCode.INVALID_STATE, 'Reopen the task before editing it');
    const deadlineChanged = input.deadline !== undefined && input.deadline.getTime() !== task.deadline.getTime();
    if (deadlineChanged) this.assertFutureDeadline(input.deadline!);
    const departmentChanged = input.departmentId !== undefined && input.departmentId !== task.departmentId;
    if (departmentChanged) {
      await this.access.assertDepartment(user, input.departmentId!);
      const ok = await this.prisma.departmentMembership.count({ where: { departmentId: input.departmentId!, userId: task.assigneeId, removedAt: null } });
      if (!ok) throw badRequest(ErrorCode.ASSIGNEE_NOT_ELIGIBLE, 'The responsible employee does not belong to that department');
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.title !== undefined && input.title !== task.title) changes.title = { from: task.title, to: input.title };
    if (input.description !== undefined && input.description !== task.description) changes.description = { from: '…', to: '…' };
    if (deadlineChanged) changes.deadline = { from: task.deadline.toISOString(), to: input.deadline!.toISOString() };
    if (input.priority !== undefined && input.priority !== task.priority) changes.priority = { from: task.priority, to: input.priority };
    if (departmentChanged) changes.departmentId = { from: task.departmentId, to: input.departmentId };
    if (Object.keys(changes).length === 0) return this.detail(taskId, access, user);

    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id: taskId },
        data: { title: input.title, description: input.description, deadline: input.deadline, priority: input.priority, departmentId: input.departmentId },
      });
      if (deadlineChanged) {
        const cycle = await this.ledger.currentCycle(tx, taskId);
        await tx.taskCycle.update({ where: { id: cycle.id }, data: { approvedDeadline: input.deadline! } });
        await this.ledger.sync(tx, taskId); // budget + reminders follow the new deadline
      }
      const action = deadlineChanged
        ? TaskHistoryAction.DEADLINE_CHANGED
        : changes.priority && Object.keys(changes).length === 1
          ? TaskHistoryAction.PRIORITY_CHANGED
          : changes.departmentId && Object.keys(changes).length === 1
            ? TaskHistoryAction.DEPARTMENT_CHANGED
            : TaskHistoryAction.UPDATED;
      const h = await tx.taskHistory.create({ data: { taskId, actorId: user.id, action, metadata: changes as Prisma.InputJsonValue } });
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_UPDATED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { fields: Object.keys(changes) } },
        `TASK_UPDATED:${h.id}`,
      );
    });
    return this.detail(taskId, access, user);
  }

  /** ADMIN changes the final approval authority (audited). */
  async changeApprover(user: AuthUser, taskId: string, approverId: string): Promise<TaskDetailDto> {
    if (!this.access.isAdmin(user)) throw forbidden('Only an admin can change the approver');
    const { task, access } = await this.access.taskAccess(user, taskId);
    if (access !== 'ADMIN') throw forbidden('Only an admin who manages this task can change its approver');
    if (task.approverId === approverId) return this.detail(taskId, 'ADMIN', user);
    await this.access.assertValidApprover(user.companyId, task.projectId, approverId);
    const inChain = await this.prisma.taskTransfer.count({ where: { taskId, cycle: { cycleNo: task.currentCycle }, status: { in: ['ACCEPTED', 'PENDING'] }, closedAt: null, OR: [{ fromUserId: approverId }, { toUserId: approverId }] } });
    if (inChain || task.assigneeId === approverId) throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, 'The approver cannot be part of the delegation chain');
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data: { approverId } });
      // A pending manager-stage submission follows the new approver.
      if (task.pendingSubmissionId) {
        await tx.taskSubmission.updateMany({ where: { id: task.pendingSubmissionId, stage: 'MANAGER', status: 'PENDING' }, data: { reviewerId: approverId } });
      }
      await tx.taskHistory.create({ data: { taskId, actorId: user.id, action: TaskHistoryAction.APPROVER_CHANGED, metadata: { from: task.approverId, to: approverId } } });
    });
    return this.detail(taskId, 'ADMIN', user);
  }

  async reassign(user: AuthUser, taskId: string, assigneeId: string): Promise<TaskDetailDto> {
    const { task, access } = await this.access.assertTaskManager(user, taskId);
    if (task.status === TaskStatus.COMPLETED) throw conflict(ErrorCode.INVALID_STATE, 'Completed tasks cannot be reassigned; reopen first');
    if (task.status === TaskStatus.PENDING_REVIEW) throw conflict(ErrorCode.INVALID_STATE, 'Decide on the pending submission before reassigning');
    if (task.pendingTransferId) throw conflict(ErrorCode.PENDING_EXISTS, 'Cancel the pending transfer before reassigning');
    if (assigneeId === task.assigneeId) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Task is already assigned to this employee');
    await this.access.assertAssignable(task.projectId, assigneeId, task.departmentId);
    if (assigneeId === task.approverId || assigneeId === task.createdById) throw badRequest(ErrorCode.ASSIGNEE_NOT_ELIGIBLE, 'The person who creates or approves a task cannot be its assignee');

    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const res = await tx.task.updateMany({
        where: { id: taskId, assigneeId: task.assigneeId, status: { in: [TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS] }, pendingTransferId: null },
        data: { assigneeId, status: TaskStatus.ASSIGNED, startedAt: null },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      const cycle = await this.ledger.currentCycle(tx, taskId);
      // A manager reassignment replaces any delegation chain.
      await tx.taskTransfer.updateMany({ where: { taskId, cycleId: cycle.id, status: 'ACCEPTED', closedAt: null }, data: { closedAt: now } });
      await this.ledger.switch(tx, taskId, now, { charged: true, chargedTo: task.assigneeId, reason: 'reassigned' }, { kind: 'ACTIVE_WORK', responsibleUserId: assigneeId });
      await this.ledger.sync(tx, taskId);
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
    return this.detail(taskId, access, user);
  }

  async start(user: AuthUser, taskId: string): Promise<TaskDetailDto> {
    const { task, access } = await this.access.taskAccess(user, taskId);
    if (task.assigneeId !== user.id) throw forbidden('Only the responsible employee can do this');
    if (task.status === TaskStatus.ASSIGNED) {
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.task.updateMany({
          where: { id: taskId, status: TaskStatus.ASSIGNED, assigneeId: user.id },
          data: { status: TaskStatus.IN_PROGRESS, startedAt: new Date() },
        });
        if (res.count === 1) await tx.taskHistory.create({ data: { taskId, actorId: user.id, action: TaskHistoryAction.STARTED } });
      });
    }
    return this.detail(taskId, access, user);
  }

  async addComment(user: AuthUser, taskId: string, input: z.infer<typeof createCommentSchema>): Promise<TaskCommentDto> {
    const { task, access } = await this.access.taskAccess(user, taskId);
    const isWorker = access === 'ASSIGNEE' || access === 'PARTICIPANT';
    const comment = await this.prisma.$transaction(async (tx) => {
      const c = await tx.taskComment.create({ data: { taskId, authorId: user.id, body: input.body } });
      await this.attachments.linkToComment(tx, user.id, taskId, c.id, input.attachmentIds);
      await tx.taskHistory.create({
        data: { taskId, actorId: user.id, action: TaskHistoryAction.COMMENTED, metadata: { commentId: c.id, attachments: input.attachmentIds.length } },
      });
      // The responsible employee replying implies work has started.
      if (access === 'ASSIGNEE' && task.status === TaskStatus.ASSIGNED) {
        const res = await tx.task.updateMany({ where: { id: taskId, status: TaskStatus.ASSIGNED }, data: { status: TaskStatus.IN_PROGRESS, startedAt: new Date() } });
        if (res.count === 1) await tx.taskHistory.create({ data: { taskId, actorId: user.id, action: TaskHistoryAction.STARTED } });
      }
      await this.outbox.taskEvent(
        tx,
        OutboxEventType.TASK_COMMENT_ADDED,
        { taskId, projectId: task.projectId, actorId: user.id, details: { commentId: c.id, byAssignee: isWorker } },
        `TASK_COMMENT_ADDED:${c.id}`,
      );
      return c;
    });
    return (await this.comments(user, taskId)).find((c) => c.id === comment.id)!;
  }

  /**
   * Reopening starts a new work cycle with its own deadline; every previous cycle, submission,
   * decision, ledger segment and document stays intact.
   */
  async reopen(user: AuthUser, taskId: string, input: z.infer<typeof reopenTaskSchema>): Promise<TaskDetailDto> {
    const { task, access } = await this.access.assertTaskManager(user, taskId);
    if (task.status !== TaskStatus.COMPLETED) throw conflict(ErrorCode.INVALID_STATE, 'Only completed tasks can be reopened');
    const deadline = input.deadline ?? task.deadline;
    this.assertFutureDeadline(deadline);

    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const prev = await this.ledger.currentCycle(tx, taskId);
      const res = await tx.task.updateMany({
        where: { id: taskId, status: TaskStatus.COMPLETED },
        data: { status: TaskStatus.ASSIGNED, completedAt: null, completedLate: null, reopenCount: { increment: 1 }, deadline },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      const cycle = await tx.taskCycle.create({
        data: { taskId, cycleNo: prev.cycleNo + 1, startedAt: now, originalDeadline: deadline, approvedDeadline: deadline, reopenReason: input.reason, reopenedById: user.id },
      });
      await tx.taskTimeSegment.create({ data: { taskId, cycleId: cycle.id, kind: 'ACTIVE_WORK', responsibleUserId: task.assigneeId, startedAt: now } });
      await this.ledger.sync(tx, taskId);
      await tx.taskHistory.create({
        data: {
          taskId,
          actorId: user.id,
          action: TaskHistoryAction.REOPENED,
          metadata: {
            reason: input.reason,
            cycleNo: cycle.cycleNo,
            previousCompletedAt: task.completedAt?.toISOString() ?? null,
            previousCompletedLate: task.completedLate,
            previousDeadline: task.deadline.toISOString(),
            newDeadline: deadline.toISOString(),
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
    });
    return this.detail(taskId, access, user);
  }

  /** Complete time ledger of every cycle (no rating data). */
  async timeLedger(user: AuthUser, taskId: string): Promise<TaskTimeLedgerDto> {
    const { task } = await this.access.taskAccess(user, taskId);
    const status = task.status;
    await this.prisma.$transaction((tx) => this.ledger.currentCycle(tx, taskId)); // self-heal legacy
    const now = new Date();
    const cycles = await this.prisma.taskCycle.findMany({ where: { taskId }, orderBy: { cycleNo: 'asc' }, include: { segments: { orderBy: { startedAt: 'asc' } } } });
    const ids = new Set<string>();
    for (const c of cycles) for (const sg of c.segments) for (const u of [sg.chargedToUserId, sg.responsibleUserId]) if (u) ids.add(u);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return {
      taskId,
      cycles: cycles.map((c) => {
        const comp = this.ledger.computeForCycle(c, c.segments, now);
        const end = c.completedAt ?? now;
        const sum = (kind: string) => c.segments.filter((sg) => sg.kind === kind).reduce((n, sg) => n + Math.max(0, (sg.endedAt ?? end).getTime() - sg.startedAt.getTime()), 0);
        const isCurrent = c.cycleNo === cycles.at(-1)!.cycleNo;
        return {
          totals: {
            activeWorkMs: sum('ACTIVE_WORK'),
            transferPendingMs: sum('TRANSFER_PENDING'),
            delegatorReviewMs: sum('DELEGATOR_REVIEW'),
            pendingReviewMs: sum('PENDING_REVIEW'),
            approvedReviewMs: sum('APPROVED_REVIEW'),
            rejectedReviewMs: sum('REJECTED_REVIEW'),
            completionMs: c.completedAt ? c.completedAt.getTime() - c.startedAt.getTime() : null,
          },
          provisional: isCurrent && !c.completedAt && status === TaskStatus.PENDING_REVIEW,
          cycleNo: c.cycleNo,
          startedAt: c.startedAt.toISOString(),
          originalDeadline: c.originalDeadline.toISOString(),
          approvedDeadline: c.approvedDeadline.toISOString(),
          budgetMs: comp.budgetMs,
          accountableMs: c.accountableMs != null ? Number(c.accountableMs) : comp.accountableMs,
          overdue: c.completedAt ? false : comp.overdue,
          overdueMs: c.lateMs != null ? Number(c.lateMs) : comp.overdueMs,
          completedAt: c.completedAt?.toISOString() ?? null,
          completedLate: c.completedLate,
          source: c.source,
          segments: c.segments.map((sg) => ({
            kind: sg.kind,
            startedAt: sg.startedAt.toISOString(),
            endedAt: sg.endedAt?.toISOString() ?? null,
            charged: sg.charged,
            chargedTo: sg.chargedToUserId ? (users.get(sg.chargedToUserId) ?? null) : null,
            responsible: sg.responsibleUserId ? (users.get(sg.responsibleUserId) ?? null) : null,
            durationMs: Math.max(0, (sg.endedAt ?? (c.completedAt ?? now)).getTime() - sg.startedAt.getTime()),
          })),
          perEmployee: Object.entries(comp.perUser).map(([id, v]) => ({ user: users.get(id) ?? { id, name: '—', email: '' }, chargedMs: v.chargedMs, lateMs: v.lateMs })),
        };
      }),
    };
  }

  /* ------------------------------ helpers ------------------------------ */

  private assertFutureDeadline(deadline: Date) {
    if (deadline.getTime() < Date.now() - DEADLINE_SKEW_MS) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Deadline must be in the future');
  }

  private async detail(taskId: string, access: TaskAccess, user: AuthUser): Promise<TaskDetailDto> {
    const t = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: taskInclude });
    const isManager = access === 'ADMIN' || access === 'MANAGER';
    const instructionFiles = await this.prisma.taskAttachment.findMany({
      where: { taskId, status: 'UPLOADED', kind: 'INSTRUCTION' },
      include: { uploadedBy: true },
      orderBy: { createdAt: 'asc' },
    });
    const [pendingSubmission, pendingTransfer, pendingExtension] = await Promise.all([
      t.pendingSubmissionId ? this.workflow.submissionDto(t.pendingSubmissionId) : null,
      t.pendingTransferId ? this.workflow.transferDto(t.pendingTransferId) : null,
      t.pendingExtensionId ? this.workflow.extensionDto(t.pendingExtensionId) : null,
    ]);
    const open = t.status === TaskStatus.ASSIGNED || t.status === TaskStatus.IN_PROGRESS;
    const responsible = t.assigneeId === user.id;
    // Admin break-glass applies only to tasks the admin manages (the task scope no longer grants admins every task).
    const isApprover = t.approverId === user.id || (isManager && this.access.isAdmin(user));
    const canSubmit = responsible && open && !t.pendingTransferId;
    return {
      ...toTaskDto(t, isManager && this.access.canSeeRating(user, t)),
      attachments: instructionFiles.map(toAttachmentDto),
      permissions: {
        canEdit: isManager && t.status !== TaskStatus.COMPLETED,
        canComment: true,
        canComplete: canSubmit,
        canSubmit,
        canStart: responsible && t.status === TaskStatus.ASSIGNED,
        canReopen: isManager && t.status === TaskStatus.COMPLETED,
        canRate: isManager && t.status === TaskStatus.COMPLETED,
        canReassign: isManager && open && !t.pendingTransferId,
        canChangeApprover: this.access.isAdmin(user) && isManager,
        canReviewAsDelegator: !!pendingSubmission && pendingSubmission.stage === 'DELEGATOR' && pendingSubmission.reviewer.id === user.id,
        canApprove: !!pendingSubmission && pendingSubmission.stage === 'MANAGER' && isApprover && pendingSubmission.submittedBy.id !== user.id,
        canWithdraw: !!pendingSubmission && pendingSubmission.submittedBy.id === user.id,
        // Employees, and admins a manager assigned the task to, can delegate it.
        canTransfer: responsible && open && !t.pendingTransferId && user.role !== UserRole.PROJECT_MANAGER,
        canRespondTransfer: !!pendingTransfer && pendingTransfer.to.id === user.id,
        canCancelTransfer: !!pendingTransfer && (pendingTransfer.from.id === user.id || isApprover),
        canRequestExtension: responsible && t.status !== TaskStatus.COMPLETED && !t.pendingExtensionId,
        canDecideExtension: !!pendingExtension && isApprover && pendingExtension.requestedBy.id !== user.id,
        canCancelExtension: !!pendingExtension && pendingExtension.requestedBy.id === user.id,
      },
      pendingSubmission,
      pendingTransfer,
      pendingExtension,
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

}
