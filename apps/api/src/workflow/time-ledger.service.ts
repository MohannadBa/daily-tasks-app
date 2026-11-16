import { Injectable } from '@nestjs/common';
import {
  backfillTaskLedger,
  computeCycle,
  effectiveDueAtFor,
  runsWhileOpen,
  type SegmentKind,
  type TaskCycle,
  type TaskTimeSegment,
} from '@dailytasks/database';
import type { TaskTimeDto } from '@dailytasks/shared-types';
import { OutboxService } from '../outbox/outbox.service';
import type { Tx } from '../prisma/prisma.service';

export interface CloseSpec {
  /** true = counted in accountable time, charged to `chargedTo`. */
  charged: boolean;
  chargedTo?: string | null;
  /** Final kind for a closing manager review (APPROVED_REVIEW / REJECTED_REVIEW). */
  kind?: SegmentKind;
  reason: string;
}

export interface OpenSpec {
  kind: SegmentKind;
  responsibleUserId: string | null;
  submissionId?: string;
  transferId?: string;
}

/**
 * Ledger operations for state transitions. Always called inside the transaction of the business
 * change, with the transaction's database time (`now()`), so the ledger, the task row and the
 * outbox commit atomically. Charging rules: docs/TIME_ACCOUNTING.md.
 */
@Injectable()
export class TimeLedgerService {
  constructor(private readonly outbox: OutboxService) {}

  /** Authoritative server timestamp: the database transaction time. */
  async now(tx: Tx): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    return row!.now;
  }

  async currentCycle(tx: Tx, taskId: string): Promise<TaskCycle> {
    let cycle = await tx.taskCycle.findFirst({ where: { taskId }, orderBy: { cycleNo: 'desc' } });
    if (!cycle) {
      // Self-heal for tasks that predate the ledger (normally done by the post-migration backfill).
      await backfillTaskLedger(tx, taskId);
      cycle = await tx.taskCycle.findFirstOrThrow({ where: { taskId }, orderBy: { cycleNo: 'desc' } });
    }
    return cycle;
  }

  async openSegment(tx: Tx, taskId: string): Promise<TaskTimeSegment | null> {
    await this.currentCycle(tx, taskId);
    return tx.taskTimeSegment.findFirst({ where: { taskId, endedAt: null } });
  }

  /** Closes the open segment (if any) at `now` per `spec`, then opens the next one (if any). */
  async switch(tx: Tx, taskId: string, now: Date, close: CloseSpec | null, open: OpenSpec | null): Promise<void> {
    const cycle = await this.currentCycle(tx, taskId);
    const current = await tx.taskTimeSegment.findFirst({ where: { taskId, endedAt: null } });
    if (current && close) {
      const end = now < current.startedAt ? current.startedAt : now;
      await tx.taskTimeSegment.update({
        where: { id: current.id },
        data: {
          endedAt: end,
          charged: close.charged,
          chargedToUserId: close.charged ? (close.chargedTo ?? current.responsibleUserId) : null,
          kind: close.kind ?? current.kind,
          closeReason: close.reason,
        },
      });
    }
    if (open) {
      await tx.taskTimeSegment.create({
        data: {
          taskId,
          cycleId: cycle.id,
          kind: open.kind,
          responsibleUserId: open.responsibleUserId,
          submissionId: open.submissionId ?? null,
          transferId: open.transferId ?? null,
          startedAt: now,
        },
      });
    }
  }

  /**
   * Recomputes the denormalised clock state of the current cycle from the ledger, bumps
   * scheduleVersion and enqueues TASK_SCHEDULE_SYNC (reminders/overdue follow effectiveDueAt).
   */
  async sync(tx: Tx, taskId: string): Promise<void> {
    const cycle = await this.currentCycle(tx, taskId);
    const segments = await tx.taskTimeSegment.findMany({ where: { cycleId: cycle.id } });
    const chargedMs = segments.filter((s) => s.charged && s.endedAt).reduce((sum, s) => sum + (s.endedAt!.getTime() - s.startedAt.getTime()), 0);
    const open = segments.find((s) => !s.endedAt);
    const clockRunningSince = open && runsWhileOpen(open.kind) ? open.startedAt : null;
    const budgetMs = Math.max(0, cycle.approvedDeadline.getTime() - cycle.startedAt.getTime());
    const t = await tx.task.update({
      where: { id: taskId },
      data: {
        currentCycle: cycle.cycleNo,
        budgetMs: BigInt(budgetMs),
        chargedMs: BigInt(chargedMs),
        clockRunningSince,
        effectiveDueAt: effectiveDueAtFor(budgetMs, chargedMs, clockRunningSince),
        scheduleVersion: { increment: 1 },
      },
    });
    await this.outbox.scheduleSync(tx, taskId, t.scheduleVersion);
  }

  /** Full per-cycle computation (time endpoint, reports, approval snapshot). */
  computeForCycle(cycle: TaskCycle, segments: TaskTimeSegment[], now: Date) {
    const budgetMs = Math.max(0, cycle.approvedDeadline.getTime() - cycle.startedAt.getTime());
    const end = cycle.completedAt ?? now;
    return computeCycle(
      segments.map((s) => ({
        kind: s.kind,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        charged: s.charged,
        chargedToUserId: s.chargedToUserId,
        responsibleUserId: s.responsibleUserId,
      })),
      budgetMs,
      end,
    );
  }
}

/** TaskTimeDto from the denormalised task columns (cheap; used by every task DTO). */
export function taskTime(
  t: { status: string; budgetMs: bigint; chargedMs: bigint; clockRunningSince: Date | null; effectiveDueAt: Date | null },
  completedSnapshot: { accountableMs: bigint | null; budgetMs: bigint | null; lateMs: bigint | null } | null,
  now = new Date(),
): TaskTimeDto {
  if (t.status === 'COMPLETED' && completedSnapshot?.accountableMs != null) {
    return {
      budgetMs: Number(completedSnapshot.budgetMs),
      accountableMs: Number(completedSnapshot.accountableMs),
      overdue: false,
      overdueMs: Number(completedSnapshot.lateMs),
      paused: true,
      effectiveDueAt: null,
    };
  }
  const budgetMs = Number(t.budgetMs);
  const accountableMs = Number(t.chargedMs) + (t.clockRunningSince ? Math.max(0, now.getTime() - t.clockRunningSince.getTime()) : 0);
  const overdue = t.status !== 'COMPLETED' && accountableMs > budgetMs;
  return {
    budgetMs,
    accountableMs,
    overdue,
    overdueMs: Math.max(0, accountableMs - budgetMs),
    paused: !t.clockRunningSince,
    effectiveDueAt: t.effectiveDueAt?.toISOString() ?? null,
  };
}
