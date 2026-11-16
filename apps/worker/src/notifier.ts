import { NotificationType, ProjectRole, type PrismaClient, type Task } from '@dailytasks/database';
import { taskDeepLink, type PushData } from '@dailytasks/shared-types';
import { logger } from './logger';
import { fmtHours, render } from './messages';
import type { PushSender } from './push';

export interface NotifyRequest {
  type: NotificationType;
  task: Task & { project: { id: string; name: string } };
  recipients: Iterable<string>;
  /** Never notify the person who caused the event. */
  actorId?: string | null;
  /** Stable key for this logical event; (userId, dedupeKey) is unique in the DB. */
  dedupeKey: string;
  vars?: { actorName?: string; offsetMinutes?: number };
  /** Per-recipient variation (e.g. previous assignee on reassignment). */
  reassignedAwayUserId?: string;
}

/**
 * Creates persistent in-app notifications (idempotently) and pushes them to every active device.
 * - Recipients are de-duplicated (a user holding several relevant roles gets one notification).
 * - Re-processing the same event creates no new rows; only rows not yet pushed are pushed.
 */
export class Notifier {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly push: PushSender,
  ) {}

  async notify(req: NotifyRequest): Promise<number> {
    const ids = new Set(req.recipients);
    if (req.actorId) ids.delete(req.actorId);
    if (ids.size === 0) return 0;

    const users = await this.prisma.user.findMany({ where: { id: { in: [...ids] }, isActive: true }, select: { id: true, locale: true } });
    await this.prisma.notification.createMany({
      data: users.map((u) => {
        const { title, body } = render(req.type, u.locale, {
          title: req.task.title,
          project: req.task.project.name,
          actor: req.vars?.actorName,
          hours: req.vars?.offsetMinutes ? fmtHours(req.vars.offsetMinutes, u.locale === 'ar' ? 'ar' : 'en') : undefined,
          reassignedAway: req.reassignedAwayUserId === u.id,
        });
        return {
          userId: u.id,
          type: req.type,
          title,
          body,
          taskId: req.task.id,
          projectId: req.task.projectId,
          dedupeKey: req.dedupeKey,
          data: { url: taskDeepLink(req.task.id) },
        };
      }),
      skipDuplicates: true,
    });

    // Push whatever has not been pushed yet for this event (covers retries after partial failure).
    const pending = await this.prisma.notification.findMany({
      where: { dedupeKey: req.dedupeKey, userId: { in: users.map((u) => u.id) }, pushedAt: null },
      include: { user: { include: { devices: { where: { disabledAt: null } } } } },
    });
    if (pending.length === 0) return 0;

    const unread = await this.prisma.notification.groupBy({
      by: ['userId'],
      where: { userId: { in: pending.map((p) => p.userId) }, readAt: null },
      _count: { _all: true },
    });
    const badge = new Map(unread.map((u) => [u.userId, u._count._all]));

    const messages = pending.flatMap((n) =>
      n.user.devices.map((d) => {
        const data: PushData = { notificationId: n.id, type: n.type, taskId: n.taskId ?? undefined, url: taskDeepLink(req.task.id) };
        return { deviceId: d.id, token: d.expoPushToken, title: n.title, body: n.body, data, badge: badge.get(n.userId) };
      }),
    );
    if (messages.length) await this.push.send(messages);
    await this.prisma.notification.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { pushedAt: new Date() } });
    logger.info('notifications delivered', { type: req.type, taskId: req.task.id, recipients: pending.length, devices: messages.length });
    return pending.length;
  }

  /** Active managers of a project. */
  async projectManagers(projectId: string): Promise<string[]> {
    const rows = await this.prisma.projectMembership.findMany({
      where: { projectId, role: ProjectRole.MANAGER, removedAt: null, user: { isActive: true } },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** The assignee, only if still an active member of the project. */
  async activeAssignee(task: Task): Promise<string[]> {
    const m = await this.prisma.projectMembership.findFirst({ where: { projectId: task.projectId, userId: task.assigneeId, removedAt: null } });
    return m ? [task.assigneeId] : [];
  }
}
