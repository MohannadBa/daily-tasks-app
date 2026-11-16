import { Injectable } from '@nestjs/common';
import { MAX_TRANSFER_DEPTH } from '@dailytasks/config';
import { OutboxEventType, Prisma, ProjectRole, TaskHistoryAction, TaskStatus, UserRole, type Task, type TaskSubmission } from '@dailytasks/database';
import type { ExtensionDto, ReviewItemDto, SubmissionDto, TransferDto, UserSummary } from '@dailytasks/shared-types';
import { taskInclude, toTaskDto } from '../tasks/task.mapper';
import type {
  approveSubmissionSchema,
  extensionDecisionSchema,
  extensionRequestSchema,
  forwardSubmissionSchema,
  rejectSubmissionSchema,
  submitTaskSchema,
  transferRequestSchema,
  z,
} from '@dailytasks/validation';
import { AccessService } from '../access/access.service';
import { AttachmentsService, toAttachmentDto } from '../attachments/attachments.service';
import type { AuthUser } from '../auth/auth.types';
import { badRequest, conflict, ErrorCode, forbidden, notFound } from '../common/errors';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { TimeLedgerService } from './time-ledger.service';

const OPEN_STATES = [TaskStatus.ASSIGNED, TaskStatus.IN_PROGRESS];
const short = (s: string | undefined | null, n = 120) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined);
const userSel = { id: true, name: true, email: true } as const;

/**
 * Task workflow state machine:
 *   ASSIGNED → IN_PROGRESS → PENDING_REVIEW → COMPLETED (approval only); rejection/return → IN_PROGRESS;
 *   reopen (TasksService) → new cycle.
 * Delegation chain: A (accountable) → B (delegate) … ; a delegate's submission is reviewed by its
 * delegator, who forwards it up; only the task approver (or an audited ADMIN) completes the task.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly ledger: TimeLedgerService,
    private readonly outbox: OutboxService,
    private readonly attachments: AttachmentsService,
  ) {}

  /* ============================== helpers ============================== */

  /** The people managing a task (creator + approver) — never every manager of the project. */
  private taskManagers(task: Pick<Task, 'createdById' | 'approverId'>): string[] {
    return [...new Set([task.createdById, task.approverId])];
  }

  /** Active (not yet closed) accepted hops of the current cycle, ordered by depth. */
  private activeChain(tx: Tx | PrismaService, task: Task, cycleId: string) {
    return tx.taskTransfer.findMany({ where: { taskId: task.id, cycleId, status: 'ACCEPTED', closedAt: null }, orderBy: { depth: 'asc' } });
  }

  private async history(tx: Tx, taskId: string, actorId: string, action: TaskHistoryAction, metadata: Record<string, unknown>) {
    return tx.taskHistory.create({ data: { taskId, actorId, action, metadata: metadata as Prisma.InputJsonValue } });
  }

  private assertOpenFor(task: Task, userId: string) {
    if (task.assigneeId !== userId) throw forbidden('Only the responsible employee can do this');
    if (!(OPEN_STATES as TaskStatus[]).includes(task.status)) throw conflict(ErrorCode.INVALID_STATE, `Task is ${task.status}`);
  }

  /* ============================ submissions ============================ */

  /**
   * Completion submission by the responsible employee (mandatory comment, optional files).
   * Delegates are reviewed by their delegator; the accountable employee by the approver.
   */
  async submit(user: AuthUser, taskId: string, input: z.infer<typeof submitTaskSchema>): Promise<SubmissionDto> {
    const { task } = await this.access.taskAccess(user, taskId);
    this.assertOpenFor(task, user.id);
    if (task.pendingTransferId) throw conflict(ErrorCode.PENDING_EXISTS, 'A transfer is pending; cancel it before submitting');

    const id = await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const cycle = await this.ledger.currentCycle(tx, taskId);
      const chain = await this.activeChain(tx, task, cycle.id);
      const myHop = chain.find((h) => h.toUserId === user.id);
      const stage = myHop ? 'DELEGATOR' : 'MANAGER';
      const reviewerId = myHop ? myHop.fromUserId : task.approverId;

      const comment = await tx.taskComment.create({ data: { taskId, authorId: user.id, body: input.comment, isCompletionNote: true } });
      await this.attachments.linkToComment(tx, user.id, taskId, comment.id, input.attachmentIds);
      await tx.taskAttachment.updateMany({ where: { commentId: comment.id }, data: { kind: 'SUBMISSION' } });
      const sub = await tx.taskSubmission.create({
        data: { taskId, cycleId: cycle.id, submittedById: user.id, commentId: comment.id, stage, reviewerId, status: 'PENDING', createdAt: now },
      });
      const res = await tx.task.updateMany({
        where: { id: taskId, assigneeId: user.id, status: { in: OPEN_STATES }, pendingSubmissionId: null, pendingTransferId: null },
        data: { status: TaskStatus.PENDING_REVIEW, pendingSubmissionId: sub.id, startedAt: task.startedAt ?? now },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');

      await this.ledger.switch(
        tx,
        taskId,
        now,
        { charged: true, chargedTo: user.id, reason: 'submitted' },
        stage === 'DELEGATOR'
          ? { kind: 'DELEGATOR_REVIEW', responsibleUserId: reviewerId, submissionId: sub.id }
          : { kind: 'PENDING_REVIEW', responsibleUserId: null, submissionId: sub.id },
      );
      await this.ledger.sync(tx, taskId);
      await this.history(tx, taskId, user.id, TaskHistoryAction.SUBMITTED, { submissionId: sub.id, stage, reviewerId, attachments: input.attachmentIds.length, commentId: comment.id });
      await this.outbox.notify(
        tx,
        stage === 'DELEGATOR' ? OutboxEventType.TASK_SUBMITTED : OutboxEventType.TASK_SUBMITTED,
        taskId,
        { taskId, projectId: task.projectId, actorId: user.id, recipients: [reviewerId] },
        `TASK_SUBMITTED:${sub.id}`,
      );
      return sub.id;
    });
    return this.submissionDto(id);
  }

  private async loadPending(user: AuthUser, submissionId: string) {
    const sub = await this.prisma.taskSubmission.findUnique({ where: { id: submissionId } });
    if (!sub) throw notFound('Submission not found');
    const { task, access } = await this.access.taskAccess(user, sub.taskId); // 404 if not visible
    if (sub.status !== 'PENDING' || task.pendingSubmissionId !== sub.id) throw conflict(ErrorCode.INVALID_STATE, 'Submission is no longer pending');
    return { sub, task, access };
  }

  /** Delegator accepts the delegate's work and sends it up the chain (to their own delegator or the approver). */
  async forward(user: AuthUser, submissionId: string, input: z.infer<typeof forwardSubmissionSchema>): Promise<SubmissionDto> {
    const { sub, task } = await this.loadPending(user, submissionId);
    if (sub.stage !== 'DELEGATOR' || sub.reviewerId !== user.id) throw forbidden('Only the delegator can forward this submission');

    const id = await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const cycle = await this.ledger.currentCycle(tx, task.id);
      const chain = await this.activeChain(tx, task, cycle.id);
      const hop = chain.find((h) => h.toUserId === sub.submittedById && h.fromUserId === user.id);
      if (!hop) throw conflict(ErrorCode.INVALID_STATE, 'Delegation no longer active');
      const parentHop = chain.find((h) => h.toUserId === user.id);
      const stage = parentHop ? 'DELEGATOR' : 'MANAGER';
      const reviewerId = parentHop ? parentHop.fromUserId : task.approverId;

      if ((await tx.taskSubmission.updateMany({ where: { id: sub.id, status: 'PENDING' }, data: { status: 'FORWARDED', decidedById: user.id, decidedAt: now, decisionReason: input.note ?? null } })).count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Submission is no longer pending');
      await tx.taskTransfer.update({ where: { id: hop.id }, data: { closedAt: now } });
      const comment = await tx.taskComment.create({
        data: { taskId: task.id, authorId: user.id, body: input.note?.trim() || 'تمت مراجعة العمل وإحالته للاعتماد · Reviewed and forwarded for approval', isCompletionNote: true },
      });
      await this.attachments.linkToComment(tx, user.id, task.id, comment.id, input.attachmentIds);
      await tx.taskAttachment.updateMany({ where: { commentId: comment.id }, data: { kind: 'SUBMISSION' } });
      const next = await tx.taskSubmission.create({
        data: { taskId: task.id, cycleId: cycle.id, submittedById: user.id, commentId: comment.id, stage, reviewerId, forwardedFromId: sub.id, createdAt: now },
      });
      const res = await tx.task.updateMany({
        where: { id: task.id, pendingSubmissionId: sub.id, status: TaskStatus.PENDING_REVIEW },
        data: { pendingSubmissionId: next.id, assigneeId: user.id },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      // Delegator review time is the delegator's (forwarded); the next review starts now.
      await this.ledger.switch(
        tx,
        task.id,
        now,
        { charged: true, chargedTo: user.id, reason: 'forwarded' },
        stage === 'DELEGATOR'
          ? { kind: 'DELEGATOR_REVIEW', responsibleUserId: reviewerId, submissionId: next.id }
          : { kind: 'PENDING_REVIEW', responsibleUserId: null, submissionId: next.id },
      );
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, TaskHistoryAction.FORWARDED, { submissionId: sub.id, newSubmissionId: next.id, to: reviewerId, stage });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_SUBMISSION_FORWARDED,
        task.id,
        { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [reviewerId] },
        `TASK_SUBMISSION_FORWARDED:${next.id}`,
      );
      return next.id;
    });
    return this.submissionDto(id);
  }

  /** Delegator sends the delegate's work back (reason required). That review time is charged to the delegate. */
  async returnToDelegate(user: AuthUser, submissionId: string, reason: string): Promise<SubmissionDto> {
    const { sub, task } = await this.loadPending(user, submissionId);
    if (sub.stage !== 'DELEGATOR' || sub.reviewerId !== user.id) throw forbidden('Only the delegator can return this submission');
    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      if ((await tx.taskSubmission.updateMany({ where: { id: sub.id, status: 'PENDING' }, data: { status: 'RETURNED', decidedById: user.id, decidedAt: now, decisionReason: reason } })).count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Submission is no longer pending');
      const res = await tx.task.updateMany({
        where: { id: task.id, pendingSubmissionId: sub.id },
        data: { status: TaskStatus.IN_PROGRESS, pendingSubmissionId: null, assigneeId: sub.submittedById },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await this.ledger.switch(tx, task.id, now, { charged: true, chargedTo: sub.submittedById, reason: 'returned' }, { kind: 'ACTIVE_WORK', responsibleUserId: sub.submittedById });
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, TaskHistoryAction.RETURNED, { submissionId: sub.id, to: sub.submittedById, reason });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_RETURNED,
        task.id,
        { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [sub.submittedById], vars: { reason: short(reason) } },
        `TASK_RETURNED:${sub.id}`,
      );
    });
    return this.submissionDto(sub.id);
  }

  /** Users who may not decide on a submission: everyone who worked on it (no self-approval). */
  private async chainUsers(tx: Tx | PrismaService, sub: TaskSubmission): Promise<Set<string>> {
    const users = new Set<string>([sub.submittedById]);
    let cur: TaskSubmission | null = sub;
    while (cur?.forwardedFromId) {
      cur = await tx.taskSubmission.findUnique({ where: { id: cur.forwardedFromId } });
      if (cur) users.add(cur.submittedById);
    }
    return users;
  }

  private async assertDecider(user: AuthUser, sub: TaskSubmission, task: Task, adminReason?: string): Promise<boolean> {
    if (sub.stage !== 'MANAGER') throw forbidden('This submission awaits the delegator, not the manager');
    if ((await this.chainUsers(this.prisma, sub)).has(user.id)) throw forbidden('You cannot decide on your own work');
    if (task.approverId === user.id) return false;
    if (user.role === UserRole.ADMIN) {
      if (!adminReason?.trim()) throw badRequest(ErrorCode.VALIDATION_FAILED, 'adminReason is required when an admin decides instead of the approver');
      return true; // audited break-glass
    }
    throw forbidden('Only the task approver can decide');
  }

  /** Final approval: the only path to COMPLETED. Snapshots time accounting and registers documents. */
  async approve(user: AuthUser, submissionId: string, input: z.infer<typeof approveSubmissionSchema>): Promise<SubmissionDto> {
    const { sub, task } = await this.loadPending(user, submissionId);
    const asAdmin = await this.assertDecider(user, sub, task, input.adminReason);

    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const cycle = await this.ledger.currentCycle(tx, task.id);
      if ((await tx.taskSubmission.updateMany({ where: { id: sub.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedById: user.id, decidedAt: now, decisionReason: asAdmin ? `[admin] ${input.adminReason}` : (input.note ?? null), decidedAsAdmin: asAdmin } })).count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Submission is no longer pending');
      // Approved review interval is excluded from accountable time.
      await this.ledger.switch(tx, task.id, now, { charged: false, kind: 'APPROVED_REVIEW', reason: 'approved' }, null);
      const segments = await tx.taskTimeSegment.findMany({ where: { cycleId: cycle.id } });
      const comp = this.ledger.computeForCycle({ ...cycle, completedAt: now }, segments, now);
      await tx.taskCycle.update({
        where: { id: cycle.id },
        data: {
          completedAt: now,
          approvedById: user.id,
          accountableMs: BigInt(comp.accountableMs),
          budgetMs: BigInt(comp.budgetMs),
          lateMs: BigInt(comp.overdueMs),
          completedLate: comp.overdue,
        },
      });
      const res = await tx.task.updateMany({
        where: { id: task.id, pendingSubmissionId: sub.id, status: TaskStatus.PENDING_REVIEW },
        data: { status: TaskStatus.COMPLETED, pendingSubmissionId: null, completedAt: now, completedLate: comp.overdue, assigneeId: sub.submittedById },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await tx.taskTransfer.updateMany({ where: { taskId: task.id, cycleId: cycle.id, status: 'ACCEPTED', closedAt: null }, data: { closedAt: now } });
      if (task.pendingExtensionId) {
        await tx.deadlineExtensionRequest.updateMany({ where: { id: task.pendingExtensionId, status: 'PENDING' }, data: { status: 'CANCELLED', decisionNote: 'task completed' } });
        await tx.task.update({ where: { id: task.id }, data: { pendingExtensionId: null } });
      }
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, TaskHistoryAction.APPROVED, {
        submissionId: sub.id,
        decidedAsAdmin: asAdmin,
        completedLate: comp.overdue,
        accountableMs: comp.accountableMs,
        budgetMs: comp.budgetMs,
      });
      const docs = await this.registerDocuments(tx, task, sub, user.id);
      const participants = await this.chainUsers(tx, sub);
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_APPROVED,
        task.id,
        { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [...participants] },
        `TASK_APPROVED:${sub.id}`,
      );
      if (asAdmin) {
        await this.outbox.notify(
          tx,
          OutboxEventType.TASK_APPROVED,
          task.id,
          { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [task.approverId], vars: { reason: 'admin' } },
          `TASK_APPROVED_ADMIN:${sub.id}`,
        );
      }
      if (docs > 0) {
        await this.outbox.notify(
          tx,
          OutboxEventType.DOCUMENT_REGISTERED,
          task.id,
          { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: this.taskManagers(task), vars: { minutes: docs } },
          `DOCUMENT_REGISTERED:${sub.id}`,
        );
      }
    });
    return this.submissionDto(sub.id);
  }

  /** Rejection: reason required; the review interval is charged to the submitter, who becomes responsible again. */
  async reject(user: AuthUser, submissionId: string, input: z.infer<typeof rejectSubmissionSchema>): Promise<SubmissionDto> {
    const { sub, task } = await this.loadPending(user, submissionId);
    const asAdmin = await this.assertDecider(user, sub, task, input.adminReason);
    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      if ((await tx.taskSubmission.updateMany({ where: { id: sub.id, status: 'PENDING' }, data: { status: 'REJECTED', decidedById: user.id, decidedAt: now, decisionReason: input.reason, decidedAsAdmin: asAdmin } })).count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Submission is no longer pending');
      const res = await tx.task.updateMany({
        where: { id: task.id, pendingSubmissionId: sub.id, status: TaskStatus.PENDING_REVIEW },
        data: { status: TaskStatus.IN_PROGRESS, pendingSubmissionId: null, assigneeId: sub.submittedById },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await this.ledger.switch(
        tx,
        task.id,
        now,
        { charged: true, chargedTo: sub.submittedById, kind: 'REJECTED_REVIEW', reason: 'rejected' },
        { kind: 'ACTIVE_WORK', responsibleUserId: sub.submittedById },
      );
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, TaskHistoryAction.REJECTED, { submissionId: sub.id, reason: input.reason, decidedAsAdmin: asAdmin, to: sub.submittedById });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_REJECTED,
        task.id,
        { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [sub.submittedById], vars: { reason: short(input.reason) } },
        `TASK_REJECTED:${sub.id}`,
      );
    });
    return this.submissionDto(sub.id);
  }

  /** Submitter withdraws before a decision. The waiting time is charged to them (no pausing the clock). */
  async withdraw(user: AuthUser, submissionId: string): Promise<SubmissionDto> {
    const { sub, task } = await this.loadPending(user, submissionId);
    if (sub.submittedById !== user.id) throw forbidden('Only the submitter can withdraw');
    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      if ((await tx.taskSubmission.updateMany({ where: { id: sub.id, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedById: user.id, decidedAt: now } })).count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Submission is no longer pending');
      const res = await tx.task.updateMany({
        where: { id: task.id, pendingSubmissionId: sub.id },
        data: { status: TaskStatus.IN_PROGRESS, pendingSubmissionId: null, assigneeId: user.id },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await this.ledger.switch(
        tx,
        task.id,
        now,
        { charged: true, chargedTo: user.id, kind: sub.stage === 'MANAGER' ? 'REJECTED_REVIEW' : undefined, reason: 'withdrawn' },
        { kind: 'ACTIVE_WORK', responsibleUserId: user.id },
      );
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, TaskHistoryAction.SUBMISSION_WITHDRAWN, { submissionId: sub.id });
    });
    return this.submissionDto(sub.id);
  }

  /**
   * Registers the approved work's files in the project's Documents Center (same S3 object, no copy).
   * Idempotent: attachmentId is unique.
   */
  private async registerDocuments(tx: Tx, task: Task, approved: TaskSubmission, actorId: string): Promise<number> {
    const commentIds: string[] = [];
    let cur: TaskSubmission | null = approved;
    while (cur) {
      commentIds.push(cur.commentId);
      cur = cur.forwardedFromId ? await tx.taskSubmission.findUnique({ where: { id: cur.forwardedFromId } }) : null;
    }
    const files = await tx.taskAttachment.findMany({ where: { commentId: { in: commentIds }, status: 'UPLOADED' } });
    if (files.length === 0) return 0;
    const project = await tx.project.findUniqueOrThrow({ where: { id: task.projectId } });
    const category = await tx.documentCategory.upsert({
      where: { companyId_code: { companyId: project.companyId, code: 'COMPLETION' } },
      create: { companyId: project.companyId, code: 'COMPLETION', nameAr: 'مخرجات المهام المعتمدة', nameEn: 'Approved task deliverables' },
      update: {},
    });
    const r = await tx.projectDocument.createMany({
      data: files.map((f) => ({
        projectId: task.projectId,
        categoryId: category.id,
        title: f.fileName,
        description: task.title,
        source: 'TASK_SUBMISSION' as const,
        visibility: 'MANAGERS_ONLY' as const,
        attachmentId: f.id,
        fileName: f.fileName,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        taskId: task.id,
        submissionId: approved.id,
        departmentId: task.departmentId,
        uploadedById: f.uploadedById,
      })),
      skipDuplicates: true,
    });
    if (r.count > 0) await this.history(tx, task.id, actorId, TaskHistoryAction.DOCUMENT_REGISTERED, { submissionId: approved.id, count: r.count });
    return r.count;
  }

  /* ============================== transfers ============================== */

  /** Responsible employee hands the task to an eligible colleague (reason required; recipient must accept). */
  async requestTransfer(user: AuthUser, taskId: string, input: z.infer<typeof transferRequestSchema>): Promise<TransferDto> {
    const { task } = await this.access.taskAccess(user, taskId);
    this.assertOpenFor(task, user.id);
    if (task.pendingTransferId) throw conflict(ErrorCode.PENDING_EXISTS, 'A transfer is already pending');

    const id = await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const cycle = await this.ledger.currentCycle(tx, taskId);
      const chain = await this.activeChain(tx, task, cycle.id);
      const root = chain[0]?.fromUserId ?? task.assigneeId;
      const inChain = new Set([root, ...chain.map((h) => h.toUserId)]);
      const depth = chain.length + 1;
      if (depth > MAX_TRANSFER_DEPTH) throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, `A task can be delegated at most ${MAX_TRANSFER_DEPTH} times`);
      if (input.toUserId === user.id) throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, 'You cannot transfer a task to yourself');
      if (inChain.has(input.toUserId)) throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, 'This employee is already in the delegation chain (circular transfer)');
      if (input.toUserId === task.approverId) throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, 'The approver cannot receive the task');
      const target = await tx.user.findFirst({ where: { id: input.toUserId, companyId: user.companyId, isActive: true, role: { in: [UserRole.EMPLOYEE, UserRole.ADMIN] } } });
      if (!target) throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, 'Recipient must be an active employee');
      await this.access.assertAssignable(task.projectId, input.toUserId, task.departmentId).catch(() => {
        throw conflict(ErrorCode.TRANSFER_CHAIN_INVALID, 'Recipient must be an employee of this project and department');
      });

      const t = await tx.taskTransfer.create({
        data: { taskId, cycleId: cycle.id, fromUserId: user.id, toUserId: input.toUserId, reason: input.reason, depth, parentTransferId: chain.at(-1)?.id ?? null, requestedAt: now },
      });
      const res = await tx.task.updateMany({
        where: { id: taskId, assigneeId: user.id, status: { in: OPEN_STATES }, pendingTransferId: null, pendingSubmissionId: null },
        data: { pendingTransferId: t.id },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await this.ledger.switch(tx, taskId, now, { charged: true, chargedTo: user.id, reason: 'transfer requested' }, { kind: 'TRANSFER_PENDING', responsibleUserId: user.id, transferId: t.id });
      await this.ledger.sync(tx, taskId);
      await this.history(tx, taskId, user.id, TaskHistoryAction.TRANSFER_REQUESTED, { transferId: t.id, to: input.toUserId, reason: input.reason, depth });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_TRANSFER_REQUESTED,
        taskId,
        { taskId, projectId: task.projectId, actorId: user.id, recipients: [input.toUserId], vars: { reason: short(input.reason) } },
        `TASK_TRANSFER_REQUESTED:${t.id}`,
      );
      return t.id;
    });
    return this.transferDto(id);
  }

  /** Colleagues the responsible employee may transfer to (same rules as requestTransfer). */
  async transferCandidates(user: AuthUser, taskId: string): Promise<UserSummary[]> {
    const { task } = await this.access.taskAccess(user, taskId);
    if (task.assigneeId !== user.id) throw forbidden('Only the responsible employee can transfer');
    const cycle = await this.prisma.$transaction((tx) => this.ledger.currentCycle(tx, taskId));
    const chain = await this.activeChain(this.prisma, task, cycle.id);
    if (chain.length + 1 > MAX_TRANSFER_DEPTH) return [];
    const excluded = [chain[0]?.fromUserId ?? task.assigneeId, ...chain.map((h) => h.toUserId), task.approverId, user.id];
    return this.prisma.user.findMany({
      where: {
        id: { notIn: excluded },
        companyId: user.companyId,
        isActive: true,
        role: { in: [UserRole.EMPLOYEE, UserRole.ADMIN] },
        memberships: { some: { projectId: task.projectId, role: ProjectRole.EMPLOYEE, removedAt: null } },
        ...(task.departmentId ? { departmentMemberships: { some: { departmentId: task.departmentId, removedAt: null } } } : {}),
      },
      select: userSel,
      orderBy: { name: 'asc' },
    });
  }

  private async loadPendingTransfer(user: AuthUser, transferId: string) {
    const t = await this.prisma.taskTransfer.findUnique({ where: { id: transferId } });
    if (!t) throw notFound('Transfer not found');
    const { task, access } = await this.access.taskAccess(user, t.taskId);
    if (t.status !== 'PENDING' || task.pendingTransferId !== t.id) throw conflict(ErrorCode.INVALID_STATE, 'Transfer is no longer pending');
    return { t, task, access };
  }

  async acceptTransfer(user: AuthUser, transferId: string, note?: string): Promise<TransferDto> {
    const { t, task } = await this.loadPendingTransfer(user, transferId);
    if (t.toUserId !== user.id) throw forbidden('Only the recipient can accept');
    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const claimed = await tx.taskTransfer.updateMany({ where: { id: t.id, status: 'PENDING' }, data: { status: 'ACCEPTED', respondedAt: now, responseNote: note ?? null } });
      if (claimed.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Transfer is no longer pending');
      const res = await tx.task.updateMany({
        where: { id: task.id, pendingTransferId: t.id },
        data: { pendingTransferId: null, assigneeId: user.id, status: TaskStatus.IN_PROGRESS, startedAt: task.startedAt ?? now },
      });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await this.ledger.switch(tx, task.id, now, { charged: true, chargedTo: t.fromUserId, reason: 'transfer accepted' }, { kind: 'ACTIVE_WORK', responsibleUserId: user.id });
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, TaskHistoryAction.TRANSFER_ACCEPTED, { transferId: t.id, from: t.fromUserId });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_TRANSFER_ACCEPTED,
        task.id,
        { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [t.fromUserId, task.approverId] },
        `TASK_TRANSFER_ACCEPTED:${t.id}`,
      );
    });
    return this.transferDto(t.id);
  }

  /** Recipient declines (reason required) or the requester/approver/admin cancels: responsibility stays with the requester. */
  async declineOrCancelTransfer(user: AuthUser, transferId: string, mode: 'DECLINE' | 'CANCEL', reason?: string): Promise<TransferDto> {
    const { t, task } = await this.loadPendingTransfer(user, transferId);
    if (mode === 'DECLINE' && t.toUserId !== user.id) throw forbidden('Only the recipient can decline');
    if (mode === 'CANCEL' && t.fromUserId !== user.id && task.approverId !== user.id && user.role !== UserRole.ADMIN) throw forbidden('Not allowed to cancel this transfer');
    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const claimed = await tx.taskTransfer.updateMany({ where: { id: t.id, status: 'PENDING' }, data: { status: mode === 'DECLINE' ? 'DECLINED' : 'CANCELLED', respondedAt: now, responseNote: reason ?? null } });
      if (claimed.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Transfer is no longer pending');
      const res = await tx.task.updateMany({ where: { id: task.id, pendingTransferId: t.id }, data: { pendingTransferId: null } });
      if (res.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Task changed concurrently, please retry');
      await this.ledger.switch(tx, task.id, now, { charged: true, chargedTo: t.fromUserId, reason: mode === 'DECLINE' ? 'transfer declined' : 'transfer cancelled' }, { kind: 'ACTIVE_WORK', responsibleUserId: t.fromUserId });
      await this.ledger.sync(tx, task.id);
      await this.history(tx, task.id, user.id, mode === 'DECLINE' ? TaskHistoryAction.TRANSFER_DECLINED : TaskHistoryAction.TRANSFER_CANCELLED, { transferId: t.id, reason: reason ?? null });
      if (mode === 'DECLINE') {
        await this.outbox.notify(
          tx,
          OutboxEventType.TASK_TRANSFER_DECLINED,
          task.id,
          { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [t.fromUserId], vars: { reason: short(reason) } },
          `TASK_TRANSFER_DECLINED:${t.id}`,
        );
      }
    });
    return this.transferDto(t.id);
  }

  /* ============================== extensions ============================== */

  async requestExtension(user: AuthUser, taskId: string, input: z.infer<typeof extensionRequestSchema>): Promise<ExtensionDto> {
    const { task } = await this.access.taskAccess(user, taskId);
    if (task.assigneeId !== user.id) throw forbidden('Only the responsible employee can request more time');
    if (task.status === TaskStatus.COMPLETED) throw conflict(ErrorCode.INVALID_STATE, 'Task is completed');
    if (task.pendingExtensionId) throw conflict(ErrorCode.PENDING_EXISTS, 'An extension request is already pending');
    const id = await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const cycle = await this.ledger.currentCycle(tx, taskId);
      const minutes = input.requestedMinutes ?? Math.ceil((input.requestedDeadline!.getTime() - cycle.approvedDeadline.getTime()) / 60_000);
      if (!Number.isFinite(minutes) || minutes < 15 || minutes > 43200) throw badRequest(ErrorCode.VALIDATION_FAILED, 'Requested extension must be between 15 minutes and 30 days after the current deadline');
      const x = await tx.deadlineExtensionRequest.create({
        data: { taskId, cycleId: cycle.id, requestedById: user.id, reason: input.reason, requestedMinutes: minutes, previousDeadline: cycle.approvedDeadline, createdAt: now },
      });
      const res = await tx.task.updateMany({ where: { id: taskId, pendingExtensionId: null, status: { not: TaskStatus.COMPLETED } }, data: { pendingExtensionId: x.id } });
      if (res.count !== 1) throw conflict(ErrorCode.PENDING_EXISTS, 'An extension request is already pending');
      await this.history(tx, taskId, user.id, TaskHistoryAction.EXTENSION_REQUESTED, { extensionId: x.id, requestedMinutes: minutes, reason: input.reason });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_EXTENSION_REQUESTED,
        taskId,
        { taskId, projectId: task.projectId, actorId: user.id, recipients: [task.approverId], vars: { minutes, reason: short(input.reason) } },
        `TASK_EXTENSION_REQUESTED:${x.id}`,
      );
      return x.id;
    });
    return this.extensionDto(id);
  }

  /** Approver (or admin) approves fully, partially or rejects. Preserves the original deadline. */
  async decideExtension(user: AuthUser, extensionId: string, input: z.infer<typeof extensionDecisionSchema>): Promise<ExtensionDto> {
    const x = await this.prisma.deadlineExtensionRequest.findUnique({ where: { id: extensionId } });
    if (!x) throw notFound('Extension request not found');
    const { task } = await this.access.taskAccess(user, x.taskId);
    if (task.approverId !== user.id && user.role !== UserRole.ADMIN) throw forbidden('Only the task approver can decide');
    if (x.requestedById === user.id) throw forbidden('You cannot decide on your own request');
    if (x.status !== 'PENDING') throw conflict(ErrorCode.INVALID_STATE, 'Request is no longer pending');
    const granted = input.decision === 'APPROVE' ? x.requestedMinutes : input.decision === 'PARTIAL' ? input.grantedMinutes! : 0;
    if (input.decision === 'PARTIAL' && (granted < 1 || granted >= x.requestedMinutes)) throw badRequest(ErrorCode.VALIDATION_FAILED, 'A partial approval must grant less than requested');

    await this.prisma.$transaction(async (tx) => {
      const now = await this.ledger.now(tx);
      const cycle = await this.ledger.currentCycle(tx, task.id);
      const newDeadline = granted > 0 ? new Date(cycle.approvedDeadline.getTime() + granted * 60_000) : null;
      const r = await tx.deadlineExtensionRequest.updateMany({
        where: { id: x.id, status: 'PENDING' },
        data: {
          status: input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'PARTIAL' ? 'PARTIALLY_APPROVED' : 'REJECTED',
          grantedMinutes: granted > 0 ? granted : null,
          newDeadline,
          decidedById: user.id,
          decidedAt: now,
          decisionNote: input.note ?? null,
        },
      });
      if (r.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Request is no longer pending');
      await tx.task.update({ where: { id: task.id }, data: { pendingExtensionId: null, ...(newDeadline ? { deadline: newDeadline } : {}) } });
      if (newDeadline) {
        await tx.taskCycle.update({ where: { id: cycle.id }, data: { approvedDeadline: newDeadline } });
        await this.ledger.sync(tx, task.id); // budget grows, reminders rescheduled
      }
      await this.history(tx, task.id, user.id, TaskHistoryAction.EXTENSION_DECIDED, {
        extensionId: x.id,
        decision: input.decision,
        grantedMinutes: granted,
        previousDeadline: cycle.approvedDeadline.toISOString(),
        newDeadline: newDeadline?.toISOString() ?? null,
        note: input.note ?? null,
      });
      await this.outbox.notify(
        tx,
        OutboxEventType.TASK_EXTENSION_DECIDED,
        task.id,
        { taskId: task.id, projectId: task.projectId, actorId: user.id, recipients: [x.requestedById], vars: { minutes: granted, reason: short(input.note) } },
        `TASK_EXTENSION_DECIDED:${x.id}`,
      );
    });
    return this.extensionDto(x.id);
  }

  async cancelExtension(user: AuthUser, extensionId: string): Promise<ExtensionDto> {
    const x = await this.prisma.deadlineExtensionRequest.findUnique({ where: { id: extensionId } });
    if (!x) throw notFound('Extension request not found');
    await this.access.taskAccess(user, x.taskId);
    if (x.requestedById !== user.id) throw forbidden('Only the requester can cancel');
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.deadlineExtensionRequest.updateMany({ where: { id: x.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (r.count !== 1) throw conflict(ErrorCode.INVALID_STATE, 'Request is no longer pending');
      await tx.task.updateMany({ where: { id: x.taskId, pendingExtensionId: x.id }, data: { pendingExtensionId: null } });
      await this.history(tx, x.taskId, user.id, TaskHistoryAction.EXTENSION_CANCELLED, { extensionId: x.id });
    });
    return this.extensionDto(x.id);
  }

  /* ================================ reads ================================ */

  async listSubmissions(user: AuthUser, taskId: string): Promise<SubmissionDto[]> {
    await this.access.taskAccess(user, taskId);
    const rows = await this.prisma.taskSubmission.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(rows.map((r) => this.submissionDto(r.id)));
  }

  async listTransfers(user: AuthUser, taskId: string): Promise<TransferDto[]> {
    await this.access.taskAccess(user, taskId);
    const rows = await this.prisma.taskTransfer.findMany({ where: { taskId }, orderBy: { requestedAt: 'asc' }, select: { id: true } });
    return Promise.all(rows.map((r) => this.transferDto(r.id)));
  }

  async listExtensions(user: AuthUser, taskId: string): Promise<ExtensionDto[]> {
    await this.access.taskAccess(user, taskId);
    const rows = await this.prisma.deadlineExtensionRequest.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(rows.map((r) => this.extensionDto(r.id)));
  }

  /**
   * Completion review inbox: pending submissions addressed to the caller (delegator or approver).
   */
  async reviewInbox(user: AuthUser): Promise<ReviewItemDto[]> {
    const where: Prisma.TaskSubmissionWhereInput = { status: 'PENDING', reviewerId: user.id, task: { project: { companyId: user.companyId } } };
    const rows = await this.prisma.taskSubmission.findMany({ where, orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, taskId: true } });
    if (!rows.length) return [];
    const tasks = await this.prisma.task.findMany({ where: { id: { in: rows.map((r) => r.taskId) } }, include: taskInclude });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const now = new Date();
    return Promise.all(
      rows.map(async (r) => ({
        submission: await this.submissionDto(r.id),
        task: toTaskDto(byId.get(r.taskId)!, false, now), // ratings never on the review inbox
      })),
    );
  }

  async incomingTransfers(user: AuthUser): Promise<TransferDto[]> {
    const rows = await this.prisma.taskTransfer.findMany({ where: { toUserId: user.id, status: 'PENDING', task: { project: { companyId: user.companyId } } }, orderBy: { requestedAt: 'desc' }, select: { id: true } });
    return Promise.all(rows.map((r) => this.transferDto(r.id)));
  }

  private async userSummary(id: string | null): Promise<UserSummary | null> {
    if (!id) return null;
    return this.prisma.user.findUnique({ where: { id }, select: userSel });
  }

  async submissionDto(id: string): Promise<SubmissionDto> {
    const s = await this.prisma.taskSubmission.findUniqueOrThrow({
      where: { id },
      include: {
        cycle: { select: { cycleNo: true } },
        submittedBy: { select: userSel },
        comment: { include: { author: { select: userSel }, attachments: { where: { status: 'UPLOADED' }, include: { uploadedBy: true } } } },
      },
    });
    return {
      id: s.id,
      cycleNo: s.cycle.cycleNo,
      stage: s.stage,
      status: s.status,
      submittedBy: s.submittedBy,
      reviewer: (await this.userSummary(s.reviewerId))!,
      comment: {
        id: s.comment.id,
        body: s.comment.body,
        isCompletionNote: s.comment.isCompletionNote,
        author: s.comment.author,
        attachments: s.comment.attachments.map(toAttachmentDto),
        createdAt: s.comment.createdAt.toISOString(),
      },
      forwardedFromId: s.forwardedFromId,
      decidedBy: await this.userSummary(s.decidedById),
      decidedAt: s.decidedAt?.toISOString() ?? null,
      decisionReason: s.decisionReason,
      decidedAsAdmin: s.decidedAsAdmin,
      createdAt: s.createdAt.toISOString(),
    };
  }

  async transferDto(id: string): Promise<TransferDto> {
    const t = await this.prisma.taskTransfer.findUniqueOrThrow({
      where: { id },
      include: { cycle: { select: { cycleNo: true } }, from: { select: userSel }, to: { select: userSel }, task: { select: { id: true, title: true, project: { select: { name: true } } } } },
    });
    return {
      id: t.id,
      task: { id: t.task.id, title: t.task.title, projectName: t.task.project.name },
      cycleNo: t.cycle.cycleNo,
      from: t.from,
      to: t.to,
      reason: t.reason,
      status: t.status,
      depth: t.depth,
      requestedAt: t.requestedAt.toISOString(),
      respondedAt: t.respondedAt?.toISOString() ?? null,
      responseNote: t.responseNote,
      closedAt: t.closedAt?.toISOString() ?? null,
    };
  }

  async extensionDto(id: string): Promise<ExtensionDto> {
    const x = await this.prisma.deadlineExtensionRequest.findUniqueOrThrow({ where: { id }, include: { cycle: { select: { cycleNo: true } }, requestedBy: { select: userSel } } });
    return {
      id: x.id,
      cycleNo: x.cycle.cycleNo,
      requestedBy: x.requestedBy,
      reason: x.reason,
      requestedMinutes: x.requestedMinutes,
      status: x.status,
      grantedMinutes: x.grantedMinutes,
      previousDeadline: x.previousDeadline.toISOString(),
      newDeadline: x.newDeadline?.toISOString() ?? null,
      decidedBy: await this.userSummary(x.decidedById),
      decidedAt: x.decidedAt?.toISOString() ?? null,
      decisionNote: x.decisionNote,
      createdAt: x.createdAt.toISOString(),
    };
  }
}
