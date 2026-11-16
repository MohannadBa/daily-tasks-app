import { Global, Injectable, Module } from '@nestjs/common';
import { OutboxEventType, type NotifyEventPayload, type Prisma, type ScheduleSyncPayload, type TaskEventPayload } from '@dailytasks/database';
import type { Tx } from '../prisma/prisma.service';

/**
 * Transactional outbox writer. Always call with the transaction client of the business change,
 * so the event is persisted if and only if the change commits. The worker relays rows to SQS.
 * Duplicate dedupe keys are ignored (idempotent writes).
 */
@Injectable()
export class OutboxService {
  async enqueue(tx: Tx, type: OutboxEventType, aggregateId: string, payload: object, dedupeKey: string) {
    await tx.outboxEvent.createMany({
      data: [{ type, aggregateId, payload: payload as Prisma.InputJsonValue, dedupeKey }],
      skipDuplicates: true,
    });
  }

  taskEvent(tx: Tx, type: OutboxEventType, payload: TaskEventPayload, dedupeKey: string) {
    return this.enqueue(tx, type, payload.taskId, payload, dedupeKey);
  }

  /** Notification event with explicit recipients (decided in the transaction). No-op when nobody is addressed. */
  notify(tx: Tx, type: OutboxEventType, aggregateId: string, payload: NotifyEventPayload, dedupeKey: string) {
    const recipients = [...new Set(payload.recipients)].filter((r) => r && r !== payload.actorId);
    if (recipients.length === 0) return Promise.resolve();
    return this.enqueue(tx, type, aggregateId, { ...payload, recipients }, dedupeKey);
  }

  scheduleSync(tx: Tx, taskId: string, scheduleVersion: number) {
    const payload: ScheduleSyncPayload = { taskId, scheduleVersion };
    return this.enqueue(tx, OutboxEventType.TASK_SCHEDULE_SYNC, taskId, payload, `SCHEDULE:${taskId}:v${scheduleVersion}`);
  }
}

@Global()
@Module({ providers: [OutboxService], exports: [OutboxService] })
export class OutboxModule {}
