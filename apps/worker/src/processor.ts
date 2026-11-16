import {
  NotificationType,
  OutboxEventType,
  TaskStatus,
  type DeadlineDuePayload,
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
  ) {}

  async handle(msg: QueueMessage): Promise<void> {
    switch (msg.type) {
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
        const recipients = byAssignee ? await this.notifier.projectManagers(task.projectId) : await this.notifier.activeAssignee(task);
        await this.notifier.notify({ ...base, type: NotificationType.TASK_COMMENT_ADDED, recipients });
        break;
      }
      case OutboxEventType.TASK_COMPLETED:
        await this.notifier.notify({ ...base, type: NotificationType.TASK_COMPLETED, recipients: await this.notifier.projectManagers(task.projectId) });
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
    const open = task.status !== TaskStatus.COMPLETED && !task.archivedAt;
    const jobs = open ? computeDeadlineJobs(task, task.project.company.reminderOffsetsMinutes) : [];
    await this.scheduler.replace(task.id, jobs);
  }

  /**
   * Fired at reminder/deadline time. Re-verifies the database:
   *  - schedule version must match (deadline not changed since),
   *  - task must still be open (a task completed before its deadline is never reported overdue),
   *  - for OVERDUE, the deadline must really have passed.
   */
  private async deadlineDue(p: DeadlineDuePayload, dedupeKey: string) {
    const task = await this.loadTask(p.taskId);
    if (!task) return;
    const now = Date.now();
    if (task.scheduleVersion !== p.scheduleVersion) return logger.debug('stale deadline event ignored', { taskId: p.taskId });
    if (task.status === TaskStatus.COMPLETED || task.archivedAt) return;

    if (p.kind === 'OVERDUE') {
      if (task.deadline.getTime() > now + EARLY_FIRE_TOLERANCE_MS) return;
      const recipients = [...(await this.notifier.activeAssignee(task)), ...(await this.notifier.projectManagers(task.projectId))];
      await this.notifier.notify({ type: NotificationType.TASK_OVERDUE, task, recipients, dedupeKey });
    } else {
      if (task.deadline.getTime() <= now) return; // already overdue, reminder pointless
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
