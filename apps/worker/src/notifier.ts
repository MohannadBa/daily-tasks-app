import { PUSH_MAX_ATTEMPTS, PUSH_MAX_CONSECUTIVE_FAILURES } from '@dailytasks/config';
import { NotificationType, ProjectRole, PushDeliveryStatus, type PrismaClient, type Task } from '@dailytasks/database';
import { REALTIME_CHANNEL, taskPath, type PushPayload, type RealtimeEnvelope } from '@dailytasks/shared-types';
import { errMsg, logger } from './logger';
import { fmtHours, render } from './messages';
import type { PushOptions, PushTransport } from './push';

export interface NotifyRequest {
  type: NotificationType;
  /** The task the notification is about (absent for PUSH_TEST). */
  task?: Task & { project: { id: string; name: string } };
  recipients: Iterable<string>;
  /** Never notify the person who caused the event. */
  actorId?: string | null;
  /** Stable key for this logical event; (userId, dedupeKey) is unique in the DB. */
  dedupeKey: string;
  vars?: { actorName?: string; offsetMinutes?: number };
  /** Per-recipient variation (e.g. previous assignee on reassignment). */
  reassignedAwayUserId?: string;
}

/** Thrown when some deliveries failed transiently; the queue message is redelivered and only those are retried. */
export class RetryableDeliveryError extends Error {
  constructor(readonly pending: number) {
    super(`${pending} push deliveries pending retry`);
    this.name = 'RetryableDeliveryError';
  }
}

const URGENT: ReadonlySet<NotificationType> = new Set([NotificationType.TASK_OVERDUE, NotificationType.TASK_DEADLINE_APPROACHING]);

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/**
 * 1. Stores the in-app notification history (idempotent on (userId, dedupeKey)) — always, even if
 *    push is disabled or fails.
 * 2. Creates one PushDelivery per (notification, active subscription) — idempotent on that pair.
 * 3. Sends only deliveries still PENDING, records the push service's answer, deactivates expired
 *    subscriptions, and throws RetryableDeliveryError if transient failures remain so SQS retries.
 * Recipients are de-duplicated (a user holding several relevant roles gets one notification).
 */
export class Notifier {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly push: PushTransport,
    private readonly concurrency = 10,
  ) {}

  async notify(req: NotifyRequest): Promise<number> {
    const ids = new Set(req.recipients);
    if (req.actorId) ids.delete(req.actorId);
    if (ids.size === 0) return 0;

    const users = await this.prisma.user.findMany({ where: { id: { in: [...ids] }, isActive: true }, select: { id: true, locale: true } });
    const url = req.task ? taskPath(req.task.id) : '/settings/notifications';
    await this.prisma.notification.createMany({
      data: users.map((u) => {
        const { title, body } = render(req.type, u.locale, {
          title: req.task?.title ?? '',
          project: req.task?.project.name ?? '',
          actor: req.vars?.actorName,
          hours: req.vars?.offsetMinutes ? fmtHours(req.vars.offsetMinutes, u.locale === 'ar' ? 'ar' : 'en') : undefined,
          reassignedAway: req.reassignedAwayUserId === u.id,
        });
        return {
          userId: u.id,
          type: req.type,
          title,
          body,
          taskId: req.task?.id ?? null,
          projectId: req.task?.projectId ?? null,
          dedupeKey: req.dedupeKey,
          data: { url },
        };
      }),
      skipDuplicates: true,
    });
    // Live update for open sessions (best effort; push below covers users who are away).
    await publishRealtime(this.prisma, users.map((u) => u.id), {
      kind: 'notification',
      type: req.type,
      taskId: req.task?.id,
      projectId: req.task?.projectId,
    });
    return this.deliver(req.dedupeKey, users.map((u) => u.id));
  }

  /** Pushes this event's notifications that are not fully processed yet (safe to call repeatedly). */
  async deliver(dedupeKey: string, userIds: string[]): Promise<number> {
    const pending = await this.prisma.notification.findMany({ where: { dedupeKey, userId: { in: userIds }, pushedAt: null } });
    if (pending.length === 0) return 0;
    const pendingIds = pending.map((n) => n.id);

    if (!this.push.enabled) {
      await this.prisma.notification.updateMany({ where: { id: { in: pendingIds } }, data: { pushedAt: new Date() } });
      logger.info('notifications stored (push disabled)', { dedupeKey, recipients: pending.length });
      return pending.length;
    }

    const subs = await this.prisma.pushSubscription.findMany({ where: { userId: { in: pending.map((n) => n.userId) }, isActive: true }, select: { id: true, userId: true } });
    const byUser = new Map<string, string[]>();
    for (const s of subs) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s.id]);
    await this.prisma.pushDelivery.createMany({
      data: pending.flatMap((n) => (byUser.get(n.userId) ?? []).map((subscriptionId) => ({ notificationId: n.id, subscriptionId }))),
      skipDuplicates: true,
    });

    const deliveries = await this.prisma.pushDelivery.findMany({
      where: { notificationId: { in: pendingIds }, status: PushDeliveryStatus.PENDING },
      include: { subscription: true, notification: true },
    });
    const unread = await this.prisma.notification.groupBy({ by: ['userId'], where: { userId: { in: pending.map((p) => p.userId) }, readAt: null }, _count: { _all: true } });
    const badge = new Map(unread.map((u) => [u.userId, u._count._all]));

    const counts = { sent: 0, expired: 0, failed: 0, retry: 0 };
    await inBatches(deliveries, this.concurrency, async (d) => {
      const n = d.notification;
      const sub = d.subscription;
      if (!sub.isActive) {
        await this.prisma.pushDelivery.update({ where: { id: d.id }, data: { status: PushDeliveryStatus.FAILED, lastError: 'subscription inactive' } });
        counts.failed++;
        return;
      }
      const payload: PushPayload = {
        v: 1,
        notificationId: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        url: n.taskId ? taskPath(n.taskId) : '/settings/notifications',
        taskId: n.taskId ?? undefined,
        badgeCount: badge.get(n.userId),
        tag: `n-${n.id}`,
        requireInteraction: n.type === NotificationType.TASK_OVERDUE || undefined,
      };
      const options: PushOptions = {
        urgency: URGENT.has(n.type) ? 'high' : 'normal',
        // Same topic on a retry replaces a still-undelivered copy at the push service (no double delivery).
        topic: n.id.replace(/-/g, ''),
      };
      let result;
      try {
        result = await this.push.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, options);
      } catch (e) {
        result = { outcome: 'transient' as const, statusCode: null, error: errMsg(e) };
      }
      const attempts = d.attempts + 1;
      const now = new Date();
      const host = safeHost(sub.endpoint);

      if (result.outcome === 'sent') {
        counts.sent++;
        await this.prisma.$transaction([
          this.prisma.pushDelivery.update({ where: { id: d.id }, data: { status: PushDeliveryStatus.SENT, attempts, statusCode: result.statusCode, lastError: null, sentAt: now } }),
          this.prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastUsedAt: now, failureCount: 0 } }),
        ]);
        return;
      }

      if (result.outcome === 'expired') {
        counts.expired++;
        await this.prisma.$transaction([
          this.prisma.pushDelivery.update({ where: { id: d.id }, data: { status: PushDeliveryStatus.EXPIRED, attempts, statusCode: result.statusCode, lastError: result.error ?? null } }),
          this.prisma.pushSubscription.update({
            where: { id: sub.id },
            data: { isActive: false, deactivatedAt: now, deactivationReason: `push service returned ${result.statusCode}` },
          }),
        ]);
        logger.info('push subscription expired; deactivated', { subscriptionId: sub.id, host, statusCode: result.statusCode });
        return;
      }

      // failed (permanent) or transient
      const giveUp = result.outcome === 'failed' || attempts >= PUSH_MAX_ATTEMPTS;
      const failureCount = sub.failureCount + 1;
      const deactivate = giveUp && (failureCount >= PUSH_MAX_CONSECUTIVE_FAILURES || result.error === 'endpoint host not allowed');
      if (giveUp) counts.failed++;
      else counts.retry++;
      await this.prisma.$transaction([
        this.prisma.pushDelivery.update({
          where: { id: d.id },
          data: { status: giveUp ? PushDeliveryStatus.FAILED : PushDeliveryStatus.PENDING, attempts, statusCode: result.statusCode, lastError: result.error ?? null },
        }),
        this.prisma.pushSubscription.update({
          where: { id: sub.id },
          data: {
            ...(giveUp ? { failureCount, lastFailureAt: now } : {}),
            ...(deactivate ? { isActive: false, deactivatedAt: now, deactivationReason: result.error === 'endpoint host not allowed' ? 'endpoint not allowed' : 'too many failures' } : {}),
          },
        }),
      ]);
      // Monitored: CloudWatch metric filter on this message (see infrastructure/aws-cdk).
      logger.warn('push delivery failed', { subscriptionId: sub.id, host, statusCode: result.statusCode, outcome: result.outcome, attempts, willRetry: !giveUp, error: result.error });
    });

    // A notification is done when none of its deliveries is still pending.
    const stillPending = await this.prisma.pushDelivery.findMany({ where: { notificationId: { in: pendingIds }, status: PushDeliveryStatus.PENDING }, select: { notificationId: true } });
    const open = new Set(stillPending.map((d) => d.notificationId));
    const done = pendingIds.filter((id) => !open.has(id));
    if (done.length) await this.prisma.notification.updateMany({ where: { id: { in: done } }, data: { pushedAt: new Date() } });
    logger.info('notifications processed', { dedupeKey, recipients: pending.length, deliveries: deliveries.length, ...counts });
    if (counts.retry > 0) throw new RetryableDeliveryError(counts.retry);
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

/** Endpoint host for logs (the full endpoint is a capability URL and is never logged). */
function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid';
  }
}

/**
 * Publishes a real-time event to every API instance via Postgres NOTIFY (see apps/api realtime).
 * Ids/types only. Chunked to stay under NOTIFY's 8000-byte payload limit. Never throws: a missed
 * live update is recovered by the client's next refetch, and push/in-app history are unaffected.
 */
export async function publishRealtime(prisma: PrismaClient, userIds: string[], event: RealtimeEnvelope['event']): Promise<void> {
  try {
    for (let i = 0; i < userIds.length; i += 100) {
      const envelope: RealtimeEnvelope = { users: userIds.slice(i, i + 100), event };
      await prisma.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(envelope)})`;
    }
  } catch (e) {
    logger.warn('realtime publish failed', { error: errMsg(e) });
  }
}

/** Housekeeping for push data (runs periodically in the worker). */
export async function pushMaintenance(prisma: PrismaClient): Promise<void> {
  const now = new Date();
  const days = (d: number) => new Date(now.getTime() - d * 24 * 3600_000);
  // Browser-reported expiry passed -> stop using it.
  await prisma.pushSubscription.updateMany({
    where: { isActive: true, expiresAt: { lt: now } },
    data: { isActive: false, deactivatedAt: now, deactivationReason: 'subscription expired' },
  });
  // Keep delivery records 30 days (diagnostics), deactivated subscriptions 30 days.
  await prisma.pushDelivery.deleteMany({ where: { createdAt: { lt: days(30) } } });
  await prisma.pushSubscription.deleteMany({ where: { isActive: false, deactivatedAt: { lt: days(30) } } });
}
