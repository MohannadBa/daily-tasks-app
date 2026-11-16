import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ListSchedulesCommand,
  ResourceNotFoundException,
  SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { randomUUID } from 'node:crypto';
import {
  deadlineScheduleName,
  OutboxEventType,
  type DeadlineDuePayload,
  type Prisma,
  type PrismaClient,
  type QueueMessage,
} from '@dailytasks/database';
import { logger } from './logger';
import type { Queue } from './queue';

export interface DeadlineJob {
  runAt: Date;
  payload: DeadlineDuePayload;
}

export interface DeadlineScheduler {
  /** Replace all schedules of a task with `jobs` (empty = cancel all). */
  replace(taskId: string, jobs: DeadlineJob[]): Promise<void>;
}

export function deadlineMessage(p: DeadlineDuePayload): QueueMessage<DeadlineDuePayload> {
  const name = deadlineScheduleName(p.taskId, p.scheduleVersion, p.kind, p.offsetMinutes);
  return { id: randomUUID(), type: OutboxEventType.TASK_DEADLINE_DUE, dedupeKey: `DEADLINE:${name}`, occurredAt: new Date().toISOString(), payload: p };
}

/**
 * Computes reminder + overdue jobs for a task. Reminders whose time already passed are skipped
 * (the assignment notification covers them); the overdue job always exists for open tasks.
 */
export function computeDeadlineJobs(task: { id: string; deadline: Date; scheduleVersion: number }, offsetsMinutes: number[], now = new Date()): DeadlineJob[] {
  const jobs: DeadlineJob[] = [];
  for (const offset of offsetsMinutes) {
    const runAt = new Date(task.deadline.getTime() - offset * 60_000);
    if (runAt.getTime() > now.getTime()) {
      jobs.push({ runAt, payload: { taskId: task.id, scheduleVersion: task.scheduleVersion, kind: 'REMINDER', offsetMinutes: offset } });
    }
  }
  jobs.push({ runAt: task.deadline, payload: { taskId: task.id, scheduleVersion: task.scheduleVersion, kind: 'OVERDUE', offsetMinutes: 0 } });
  return jobs;
}

/* ------------------------------------------------------------------ */
/* Local development: schedules stored in Postgres, polled by worker   */
/* ------------------------------------------------------------------ */

export class LocalDbScheduler implements DeadlineScheduler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: Queue,
  ) {}

  async replace(taskId: string, jobs: DeadlineJob[]) {
    await this.prisma.$transaction(async (tx) => {
      await tx.scheduledEvent.deleteMany({ where: { name: { startsWith: `t-${taskId}-` }, firedAt: null } });
      if (jobs.length) {
        await tx.scheduledEvent.createMany({
          data: jobs.map((j) => ({
            name: deadlineScheduleName(j.payload.taskId, j.payload.scheduleVersion, j.payload.kind, j.payload.offsetMinutes),
            runAt: j.runAt,
            payload: j.payload as unknown as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
      }
    });
  }

  /** Moves due schedules onto the queue. SKIP LOCKED allows several worker replicas. */
  async fireDue(limit = 100): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string; payload: DeadlineDuePayload }>>`
      UPDATE "ScheduledEvent" SET "firedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "ScheduledEvent" WHERE "firedAt" IS NULL AND "runAt" <= now()
        ORDER BY "runAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "payload"`;
    for (const row of due) {
      try {
        await this.queue.send(deadlineMessage(row.payload));
      } catch (e) {
        await this.prisma.scheduledEvent.update({ where: { id: row.id }, data: { firedAt: null } });
        throw e;
      }
    }
    return due.length;
  }
}

/* ------------------------------------------------------------------ */
/* Production: EventBridge Scheduler one-time schedules -> SQS          */
/* ------------------------------------------------------------------ */

export class EventBridgeDeadlineScheduler implements DeadlineScheduler {
  private readonly client: SchedulerClient;
  constructor(
    private readonly opts: { region: string; groupName: string; targetQueueArn: string; roleArn: string; endpoint?: string },
    private readonly queue: Queue,
  ) {
    this.client = new SchedulerClient({ region: opts.region, endpoint: opts.endpoint });
  }

  async replace(taskId: string, jobs: DeadlineJob[]) {
    const wanted = new Set(jobs.map((j) => deadlineScheduleName(j.payload.taskId, j.payload.scheduleVersion, j.payload.kind, j.payload.offsetMinutes)));
    // Delete stale schedules (old versions). Even if this fails, stale events are ignored on delivery.
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListSchedulesCommand({ GroupName: this.opts.groupName, NamePrefix: `t-${taskId}-`, NextToken: token }));
      for (const s of page.Schedules ?? []) {
        if (s.Name && !wanted.has(s.Name)) {
          try {
            await this.client.send(new DeleteScheduleCommand({ GroupName: this.opts.groupName, Name: s.Name }));
          } catch (e) {
            if (!(e instanceof ResourceNotFoundException)) throw e;
          }
        }
      }
      token = page.NextToken;
    } while (token);

    const minFuture = Date.now() + 60_000;
    for (const job of jobs) {
      const name = deadlineScheduleName(job.payload.taskId, job.payload.scheduleVersion, job.payload.kind, job.payload.offsetMinutes);
      if (job.runAt.getTime() < minFuture) {
        // Too close (or already past) for a schedule: enqueue directly; delivery-time checks still apply.
        await this.queue.send(deadlineMessage(job.payload));
        continue;
      }
      try {
        await this.client.send(
          new CreateScheduleCommand({
            Name: name,
            GroupName: this.opts.groupName,
            ScheduleExpression: `at(${job.runAt.toISOString().slice(0, 19)})`,
            ScheduleExpressionTimezone: 'UTC',
            FlexibleTimeWindow: { Mode: 'OFF' },
            ActionAfterCompletion: 'DELETE',
            Target: {
              Arn: this.opts.targetQueueArn,
              RoleArn: this.opts.roleArn,
              Input: JSON.stringify(deadlineMessage(job.payload)),
              RetryPolicy: { MaximumRetryAttempts: 20, MaximumEventAgeInSeconds: 86400 },
            },
          }),
        );
      } catch (e) {
        if (e instanceof ConflictException) continue; // already created by a previous attempt
        throw e;
      }
    }
    logger.debug('eventbridge schedules replaced', { taskId, count: jobs.length });
  }
}
