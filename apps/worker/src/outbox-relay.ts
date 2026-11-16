import { OutboxStatus, type OutboxEventType, type PrismaClient, type QueueMessage } from '@dailytasks/database';
import { errMsg, logger } from './logger';
import type { Queue } from './queue';

const MAX_ATTEMPTS = 10;

/**
 * Relays committed OutboxEvent rows to SQS. Rows are claimed with FOR UPDATE SKIP LOCKED so
 * several worker replicas can run safely. Failures back off exponentially; after MAX_ATTEMPTS
 * a row is marked FAILED (alarmed on in CloudWatch via the worker's error logs/metric filter).
 * Delivery is at-least-once; consumers are idempotent via dedupe keys.
 */
export class OutboxRelay {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: Queue,
  ) {}

  async relayBatch(limit = 50): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; type: string; payload: unknown; dedupeKey: string; attempts: number; createdAt: Date }>>`
          SELECT "id", "type", "payload", "dedupeKey", "attempts", "createdAt" FROM "OutboxEvent"
          WHERE "status" = 'PENDING' AND "availableAt" <= now()
          ORDER BY "createdAt" LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`;
        for (const row of rows) {
          const message: QueueMessage = {
            id: row.id,
            type: row.type as OutboxEventType,
            dedupeKey: row.dedupeKey,
            occurredAt: row.createdAt.toISOString(),
            payload: row.payload,
          };
          try {
            await this.queue.send(message);
            await tx.outboxEvent.update({ where: { id: row.id }, data: { status: OutboxStatus.PUBLISHED, publishedAt: new Date(), attempts: { increment: 1 } } });
          } catch (e) {
            const attempts = row.attempts + 1;
            const delayMs = Math.min(2 ** attempts * 1000, 15 * 60 * 1000);
            await tx.outboxEvent.update({
              where: { id: row.id },
              data: {
                attempts,
                lastError: errMsg(e).slice(0, 500),
                availableAt: new Date(Date.now() + delayMs),
                status: attempts >= MAX_ATTEMPTS ? OutboxStatus.FAILED : OutboxStatus.PENDING,
              },
            });
            logger.error('outbox publish failed', { outboxId: row.id, attempts, error: errMsg(e) });
          }
        }
        return rows.length;
      },
      { timeout: 60_000 },
    );
  }

  /** Remove published rows after retention (keeps the table small). */
  async cleanup(retentionDays = 7) {
    const res = await this.prisma.outboxEvent.deleteMany({
      where: { status: OutboxStatus.PUBLISHED, publishedAt: { lt: new Date(Date.now() - retentionDays * 86400_000) } },
    });
    if (res.count) logger.info('outbox cleanup', { deleted: res.count });
  }
}
