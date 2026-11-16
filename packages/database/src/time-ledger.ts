/**
 * Time accounting engine (pure, no I/O). Shared by the API (state transitions) and the worker
 * (reminder / overdue re-checks) so both compute identically. Spec: docs/TIME_ACCOUNTING.md.
 *
 * Model: a task's cycle [start, end) is partitioned into consecutive ledger segments. Closed
 * segments are either CHARGED to one user (counted) or EXCLUDED (approved manager review). The open
 * segment counts while it "runs" (everything except an open manager review, which is provisionally
 * paused until the approver decides).
 *
 *   accountable(t) = Σ closed charged durations + (running ? t − openStart : 0)
 *   overdue(t)     = status ≠ COMPLETED ∧ accountable(t) > budget        (strict)
 *   budget         = approvedDeadline − cycleStart  (extensions add to both)
 */

export type LedgerSegmentKind =
  | 'ACTIVE_WORK'
  | 'TRANSFER_PENDING'
  | 'DELEGATOR_REVIEW'
  | 'PENDING_REVIEW'
  | 'APPROVED_REVIEW'
  | 'REJECTED_REVIEW';

export interface LedgerSegment {
  kind: LedgerSegmentKind;
  startedAt: Date;
  endedAt: Date | null;
  /** Closed and counted. */
  charged: boolean;
  chargedToUserId: string | null;
  /** Whose clock it is while open. */
  responsibleUserId: string | null;
}

/** Does an OPEN segment of this kind make the clock run? (Manager review is provisionally paused.) */
export function runsWhileOpen(kind: LedgerSegmentKind): boolean {
  return kind === 'ACTIVE_WORK' || kind === 'TRANSFER_PENDING' || kind === 'DELEGATOR_REVIEW';
}

export interface CycleComputation {
  accountableMs: number;
  budgetMs: number;
  overdue: boolean;
  overdueMs: number;
  /** Clock currently running (an open charged segment). */
  running: boolean;
  /** When accountable time reaches the budget if the clock keeps running; null while paused. */
  effectiveDueAt: Date | null;
  /** Per user: accountable ms charged to them and the part of the overdue time attributed to them. */
  perUser: Record<string, { chargedMs: number; lateMs: number }>;
}

const ms = (a: Date, b: Date) => Math.max(0, b.getTime() - a.getTime());

/**
 * Computes accountable time, overdue state and per-employee attribution for one cycle at `now`.
 * Late attribution: walking segments in time order, the part of each counted segment that lies
 * beyond the budget is attributed to whoever that segment is charged to (Σ lateMs = overdueMs).
 */
export function computeCycle(segments: LedgerSegment[], budgetMs: number, now: Date): CycleComputation {
  const ordered = [...segments].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const perUser: CycleComputation['perUser'] = {};
  let acc = 0;
  let running = false;
  let openStart: Date | null = null;
  for (const s of ordered) {
    let duration = 0;
    let user: string | null = null;
    if (s.endedAt) {
      if (!s.charged) continue;
      duration = ms(s.startedAt, s.endedAt);
      user = s.chargedToUserId;
    } else if (runsWhileOpen(s.kind)) {
      running = true;
      openStart = s.startedAt;
      duration = ms(s.startedAt, now);
      user = s.responsibleUserId;
    } else {
      continue; // open manager review: provisionally excluded
    }
    const before = acc;
    acc += duration;
    const late = Math.max(0, acc - Math.max(budgetMs, before));
    if (user) {
      const u = (perUser[user] ??= { chargedMs: 0, lateMs: 0 });
      u.chargedMs += duration;
      u.lateMs += late;
    }
  }
  const overdueMs = Math.max(0, acc - budgetMs);
  let effectiveDueAt: Date | null = null;
  if (running && openStart) {
    const closed = acc - ms(openStart, now);
    effectiveDueAt = new Date(openStart.getTime() + (budgetMs - closed));
  }
  return { accountableMs: acc, budgetMs, overdue: acc > budgetMs, overdueMs, running, effectiveDueAt, perUser };
}

/** Denormalised fast path (Task columns): accountable time without loading segments. */
export function accountableFromDenormalized(chargedMs: number, clockRunningSince: Date | null, now: Date): number {
  return chargedMs + (clockRunningSince ? ms(clockRunningSince, now) : 0);
}

export function isOverdueDenormalized(
  t: { status: string; chargedMs: number | bigint; budgetMs: number | bigint; clockRunningSince: Date | null },
  now = new Date(),
): boolean {
  if (t.status === 'COMPLETED') return false;
  return accountableFromDenormalized(Number(t.chargedMs), t.clockRunningSince, now) > Number(t.budgetMs);
}

/** effectiveDueAt for the denormalised columns: runningSince + (budget − closed charged). */
export function effectiveDueAtFor(budgetMs: number, chargedMs: number, clockRunningSince: Date | null): Date | null {
  return clockRunningSince ? new Date(clockRunningSince.getTime() + (budgetMs - chargedMs)) : null;
}
