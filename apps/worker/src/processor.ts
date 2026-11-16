import {
  accountableFromDenormalized,
  NOTIFY_EVENT_TYPES,
  NotificationType,
  OutboxEventType,
  TaskStatus,
  type DeadlineDuePayload,
  type NotifyEventPayload,
  type ReportRenderPayload,
  type PrismaClient,
  type PushTestPayload,
  type QueueMessage,
  type ScheduleSyncPayload,
  type TaskEventPayload,
} from '@dailytasks/database';
import { logger } from './logger';
import type { Notifier } from './notifier';
import { computeDeadlineJobs, type DeadlineScheduler } from './scheduler';

/** Tolerance for schedulers firing marginally early. */
const EARLY_FIRE_TOLERANCE_MS = 5_000;

/**
 * Handles one queue message. Every handler is idempotent and re-reads current DB state,
 * so redelivery, reordering and stale scheduled events are all safe.
 */
export class EventProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifier: Notifier,
    private readonly scheduler: DeadlineScheduler,
    /** Renders a queued PDF report (absent when REPORTS_ENABLED=false). */
    private readonly renderReport?: (reportId: string) => Promise<void>,
  ) {}

  async handle(msg: QueueMessage): Promise<void> {
    if ((NOTIFY_EVENT_TYPES as readonly string[]).includes(msg.type)) return this.notifyEvent(msg.type as NotificationType, msg.payload as NotifyEventPayload, msg.dedupeKey);
    switch (msg.type) {
      case OutboxEventType.REPORT_RENDER: {
        if (!this.renderReport) return logger.warn('report rendering disabled; dropping', { dedupeKey: msg.dedupeKey });
        return this.renderReport((msg.payload as ReportRenderPayload).reportId);
      }
      case OutboxEventType.TASK_SCHEDULE_SYNC:
        return this.scheduleSync(msg.payload as ScheduleSyncPayload);
      case OutboxEventType.TASK_DEADLINE_DUE:
        return this.deadlineDue(msg.payload as DeadlineDuePayload, msg.dedupeKey);
      case OutboxEventType.TASK_ASSIGNED:
      case OutboxEventType.TASK_UPDATED:
      case OutboxEventType.TASK_REASSIGNED:
      case OutboxEventType.TASK_COMMENT_ADDED:
      case OutboxEventType.TASK_COMPLETED:
      case OutboxEventType.TASK_REOPENED:
        return this.taskEvent(msg.type, msg.payload as TaskEventPayload, msg.dedupeKey);
      case OutboxEventType.PUSH_TEST: {
        // Only to the requesting user (the API enqueues it for the authenticated caller).
        const p = msg.payload as PushTestPayload;
        await this.notifier.notify({ type: NotificationType.PUSH_TEST, recipients: [p.userId], dedupeKey: msg.dedupeKey });
        return;
      }
      default:
        logger.warn('unknown message type; dropping', { type: msg.type });
    }
  }

  /**
   * Workflow notifications with explicit recipients decided in the API transaction
   * (approver, delegator, submitter …). Inactive users are skipped by the notifier.
   */
  private async notifyEvent(type: NotificationType, p: NotifyEventPayload, dedupeKey: string) {
    const task = p.taskId ? await this.loadTask(p.taskId) : null;
    if (p.taskId && !task) return logger.warn('task not found for event', { type, taskId: p.taskId });
    const actor = p.actorId ? await this.prisma.user.findUnique({ where: { id: p.actorId }, select: { name: true } }) : null;
    let projectName: string | undefined;
    if (!task && p.projectId) projectName = (await this.prisma.project.findUnique({ where: { id: p.projectId }, select: { name: true } }))?.name;
    await this.notifier.notify({
      type,
      task: task ?? undefined,
      recipients: p.recipients,
      actorId: p.actorId,
      dedupeKey,
      url: p.url,
      projectId: p.projectId,
      vars: { actorName: actor?.name, reason: p.vars?.reason, minutes: p.vars?.minutes, name: p.vars?.name ?? projectName },
    });
  }

  private loadTask(taskId: string) {
    return this.prisma.task.findUnique({ where: { id: taskId }, include: { project: { select: { id: true, name: true } } } });
  }

  private async taskEvent(type: OutboxEventType, p: TaskEventPayload, dedupeKey: string) {
    const task = await this.loadTask(p.taskId);
    if (!task) return logger.warn('task not found for event', { type, taskId: p.taskId });
    const actor = p.actorId ? await this.prisma.user.findUnique({ where: { id: p.actorId }, select: { name: true } }) : null;
    const base = { task, actorId: p.actorId, dedupeKey, vars: { actorName: actor?.name } };

    switch (type) {
      case OutboxEventType.TASK_ASSIGNED:
        await this.notifier.notify({ ...base, type: NotificationType.TASK_ASSIGNED, recipients: await this.notifier.activeAssignee(task) });
        break;
      case OutboxEventType.TASK_UPDATED:
        await this.notifier.notify({ ...base, type: NotificationType.TASK_UPDATED, recipients: await this.notifier.activeAssignee(task) });
        break;
      case OutboxEventType.TASK_REASSIGNED: {
        const previous = p.details?.previousAssigneeId as string | undefined;
        const newAssignee = p.details?.newAssigneeId as string | undefined;
        const recipients = [newAssignee, previous].filter((x): x is string => !!x);
        await this.notifier.notify({ ...base, type: NotificationType.TASK_REASSIGNED, recipients, reassignedAwayUserId: previous });
        break;
      }
      case OutboxEventType.TASK_COMMENT_ADDED: {
        // Employee replies go to the project's managers; manager replies go to the assignee.
        const byAssignee = p.details?.byAssignee === true;
        const recipients = byAssignee ? await this.notifier.taskManagers(task) : await this.notifier.activeAssignee(task);
        await this.notifier.notify({ ...base, type: NotificationType.TASK_COMMENT_ADDED, recipients });
        break;
      }
      case OutboxEventType.TASK_COMPLETED:
        await this.notifier.notify({ ...base, type: NotificationType.TASK_COMPLETED, recipients: await this.notifier.taskManagers(task) });
        break;
      case OutboxEventType.TASK_REOPENED:
        await this.notifier.notify({ ...base, type: NotificationType.TASK_REOPENED, recipients: await this.notifier.activeAssignee(task) });
        break;
    }
  }

  /** (Re)creates schedules, but only if this sync is for the task's current schedule version. */
  private async scheduleSync(p: ScheduleSyncPayload) {
    const task = await this.prisma.task.findUnique({ where: { id: p.taskId }, include: { project: { include: { company: true } } } });
    if (!task) return;
    if (task.scheduleVersion !== p.scheduleVersion) {
      logger.debug('stale schedule sync ignored', { taskId: p.taskId, version: p.scheduleVersion, current: task.scheduleVersion });
      return;
    }
    // Reminders/overdue follow the accountable clock: effectiveDueAt is when accountable time reaches
    // the budget if the clock keeps running. Paused (pending review) or completed tasks get no jobs.
    const open = task.status !== TaskStatus.COMPLETED && !task.archivedAt && !!task.effectiveDueAt;
    const jobs = open ? computeDeadlineJobs({ id: task.id, deadline: task.effectiveDueAt!, scheduleVersion: task.scheduleVersion }, task.project.company.reminderOffsetsMinutes) : [];
    await this.scheduler.replace(task.id, jobs);
  }

  /**
   * Fired at reminder/deadline time. Re-verifies the database:
   *  - schedule version must match (no ledger/deadline change since),
   *  - task must still be open (a task completed or approved before its deadline is never overdue),
   *  - for OVERDUE, accountable time must really exceed the budget (time-ledger rule).
   */
  private async deadlineDue(p: DeadlineDuePayload, dedupeKey: string) {
    const task = await this.loadTask(p.taskId);
    if (!task) return;
    const now = Date.now();
    if (task.scheduleVersion !== p.scheduleVersion) return logger.debug('stale deadline event ignored', { taskId: p.taskId });
    if (task.status === TaskStatus.COMPLETED || task.archivedAt) return;

    if (!task.clockRunningSince) return; // paused (pending manager review): never reported meanwhile
    const accountable = accountableFromDenormalized(Number(task.chargedMs), task.clockRunningSince, new Date(now));
    const budget = Number(task.budgetMs);

    if (p.kind === 'OVERDUE') {
      if (accountable + EARLY_FIRE_TOLERANCE_MS <= budget) return;
      const recipients = [...(await this.notifier.activeAssignee(task)), ...(await this.notifier.taskManagers(task))];
      // One overdue alert per work cycle, even if the clock pauses and resumes (new schedule versions).
      await this.notifier.notify({ type: NotificationType.TASK_OVERDUE, task, recipients, dedupeKey: `TASK_OVERDUE:${task.id}:c${task.currentCycle}` });
    } else {
      if (accountable >= budget) return; // already overdue, reminder pointless
      await this.notifier.notify({
        type: NotificationType.TASK_DEADLINE_APPROACHING,
        task,
        recipients: await this.notifier.activeAssignee(task),
        dedupeKey,
        vars: { offsetMinutes: p.offsetMinutes },
      });
    }
  }
}
