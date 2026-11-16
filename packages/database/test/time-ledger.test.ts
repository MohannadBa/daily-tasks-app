import { describe, expect, it } from 'vitest';
import { computeCycle, effectiveDueAtFor, isOverdueDenormalized, type LedgerSegment, type LedgerSegmentKind } from '../src/time-ledger';

const H = 3600_000;
const T0 = new Date('2030-01-01T00:00:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * H);
const E = 'employee';
const A = 'delegatorA';
const B = 'delegateB';

/** closed segment helper */
const seg = (kind: LedgerSegmentKind, from: number, to: number | null, chargedTo: string | null, responsible: string | null = chargedTo): LedgerSegment => ({
  kind,
  startedAt: at(from),
  endedAt: to === null ? null : at(to),
  charged: to !== null && chargedTo !== null,
  chargedToUserId: to === null ? null : chargedTo,
  responsibleUserId: responsible,
});
const hours = (msv: number) => msv / H;

describe('time ledger — required examples', () => {
  it('Example 1: 22 h of work + 8 h approved review = 22 accountable hours (on time)', () => {
    const c = computeCycle([seg('ACTIVE_WORK', 0, 22, E), seg('APPROVED_REVIEW', 22, 30, null)], 24 * H, at(30));
    expect(hours(c.accountableMs)).toBe(22);
    expect(c.overdue).toBe(false);
    expect(c.overdueMs).toBe(0);
  });

  it('Example 2: 22 h of work + 6 h rejected review = 28 accountable hours, 4 h late (charged to the employee)', () => {
    const c = computeCycle([seg('ACTIVE_WORK', 0, 22, E), seg('REJECTED_REVIEW', 22, 28, E), seg('ACTIVE_WORK', 28, null, null, E)], 24 * H, at(28));
    expect(hours(c.accountableMs)).toBe(28);
    expect(c.overdue).toBe(true);
    expect(hours(c.overdueMs)).toBe(4);
    expect(hours(c.perUser[E]!.lateMs)).toBe(4);
    expect(c.running).toBe(true);
  });
});

describe('time ledger — cycles, rejections, extensions, transfers', () => {
  it('rejected then resubmitted and approved: completed 5 h late', () => {
    const c = computeCycle(
      [seg('ACTIVE_WORK', 0, 22, E), seg('REJECTED_REVIEW', 22, 28, E), seg('ACTIVE_WORK', 28, 29, E), seg('APPROVED_REVIEW', 29, 31, null)],
      24 * H,
      at(31),
    );
    expect(hours(c.accountableMs)).toBe(29);
    expect(hours(c.overdueMs)).toBe(5);
  });

  it('multiple rejections: each rejected review is charged, the approved one excluded', () => {
    const c = computeCycle(
      [
        seg('ACTIVE_WORK', 0, 10, E),
        seg('REJECTED_REVIEW', 10, 12, E),
        seg('ACTIVE_WORK', 12, 15, E),
        seg('REJECTED_REVIEW', 15, 16, E),
        seg('ACTIVE_WORK', 16, 18, E),
        seg('APPROVED_REVIEW', 18, 40, null),
      ],
      24 * H,
      at(40),
    );
    expect(hours(c.accountableMs)).toBe(18);
    expect(c.overdue).toBe(false);
  });

  it('pending manager review pauses the clock provisionally; a late submission stays late', () => {
    const onTime = computeCycle([seg('ACTIVE_WORK', 0, 22, E), seg('PENDING_REVIEW', 22, null, null, null)], 24 * H, at(100));
    expect(hours(onTime.accountableMs)).toBe(22);
    expect(onTime.overdue).toBe(false);
    expect(onTime.running).toBe(false);
    expect(onTime.effectiveDueAt).toBeNull();
    const late = computeCycle([seg('ACTIVE_WORK', 0, 25, E), seg('PENDING_REVIEW', 25, null, null, null)], 24 * H, at(30));
    expect(late.overdue).toBe(true);
    expect(hours(late.overdueMs)).toBe(1);
  });

  it('extension raises the budget; an overdue task can become on-time again', () => {
    const segs = [seg('ACTIVE_WORK', 0, null, null, E)];
    expect(computeCycle(segs, 24 * H, at(26)).overdue).toBe(true);
    const extended = computeCycle(segs, 28 * H, at(26));
    expect(extended.overdue).toBe(false);
    expect(extended.effectiveDueAt).toEqual(at(28));
  });

  it('transfer chain A → B → A → manager: per-employee accountability (A 9 h, B 11 h)', () => {
    const c = computeCycle(
      [
        seg('ACTIVE_WORK', 0, 5, A),
        seg('TRANSFER_PENDING', 5, 7, A),
        seg('ACTIVE_WORK', 7, 18, B),
        seg('DELEGATOR_REVIEW', 18, 20, A),
        seg('APPROVED_REVIEW', 20, 30, null),
      ],
      24 * H,
      at(30),
    );
    expect(hours(c.accountableMs)).toBe(20);
    expect(hours(c.perUser[A]!.chargedMs)).toBe(9);
    expect(hours(c.perUser[B]!.chargedMs)).toBe(11);
    expect(c.overdue).toBe(false);
  });

  it('manager rejects a forwarded submission: review charged to the forwarding employee A, lateness attributed to A', () => {
    const c = computeCycle(
      [
        seg('ACTIVE_WORK', 0, 5, A),
        seg('TRANSFER_PENDING', 5, 7, A),
        seg('ACTIVE_WORK', 7, 18, B),
        seg('DELEGATOR_REVIEW', 18, 20, A),
        seg('REJECTED_REVIEW', 20, 30, A),
      ],
      24 * H,
      at(30),
    );
    expect(hours(c.accountableMs)).toBe(30);
    expect(hours(c.overdueMs)).toBe(6);
    expect(hours(c.perUser[A]!.lateMs)).toBe(6);
    expect(c.perUser[B]!.lateMs).toBe(0);
  });

  it('delegator returns the work to the delegate: that review is charged to the delegate', () => {
    const c = computeCycle(
      [seg('ACTIVE_WORK', 0, 7, A), seg('ACTIVE_WORK', 7, 18, B), seg('DELEGATOR_REVIEW', 18, 20, B), seg('ACTIVE_WORK', 20, 22, B)],
      24 * H,
      at(22),
    );
    expect(hours(c.perUser[B]!.chargedMs)).toBe(15);
    expect(hours(c.perUser[A]!.chargedMs)).toBe(7);
  });

  it('lateness split across employees when the budget runs out during a hand-over', () => {
    const c = computeCycle([seg('ACTIVE_WORK', 0, 20, A), seg('ACTIVE_WORK', 20, 30, B)], 24 * H, at(30));
    expect(hours(c.perUser[A]!.lateMs)).toBe(0);
    expect(hours(c.perUser[B]!.lateMs)).toBe(6);
    expect(c.overdueMs).toBe(c.perUser[A]!.lateMs + c.perUser[B]!.lateMs);
  });
});

describe('time ledger — boundaries & invariants', () => {
  it('exactly at the budget is on time (strict >)', () => {
    expect(computeCycle([seg('ACTIVE_WORK', 0, 24, E)], 24 * H, at(24)).overdue).toBe(false);
    const oneMsLate = computeCycle([{ ...seg('ACTIVE_WORK', 0, 24, E), endedAt: new Date(at(24).getTime() + 1) }], 24 * H, at(25));
    expect(oneMsLate.overdue).toBe(true);
    expect(oneMsLate.overdueMs).toBe(1);
  });

  it('effectiveDueAt accounts for excluded time', () => {
    // 10 h work, 6 h approved review is impossible mid-cycle, but a rejected review is charged:
    const c = computeCycle([seg('ACTIVE_WORK', 0, 10, E), seg('REJECTED_REVIEW', 10, 12, E), seg('ACTIVE_WORK', 12, null, null, E)], 24 * H, at(13));
    expect(c.effectiveDueAt).toEqual(at(24)); // nothing excluded → due at wall-clock deadline
    expect(effectiveDueAtFor(24 * H, 12 * H, at(12))).toEqual(at(24));
  });

  it('randomised: attribution always sums to the overdue time and charged time to accountable time', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const users = ['u1', 'u2', 'u3'];
    for (let run = 0; run < 500; run++) {
      const segments: LedgerSegment[] = [];
      let t = 0;
      const n = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) {
        const d = Math.floor(rnd() * 10 * H);
        const kind = (['ACTIVE_WORK', 'REJECTED_REVIEW', 'APPROVED_REVIEW', 'DELEGATOR_REVIEW', 'TRANSFER_PENDING'] as const)[Math.floor(rnd() * 5)]!;
        const user = kind === 'APPROVED_REVIEW' ? null : users[Math.floor(rnd() * 3)]!;
        segments.push({ kind, startedAt: new Date(T0.getTime() + t), endedAt: new Date(T0.getTime() + t + d), charged: user !== null, chargedToUserId: user, responsibleUserId: user });
        t += d;
      }
      const budget = Math.floor(rnd() * 40 * H);
      const c = computeCycle(segments, budget, new Date(T0.getTime() + t));
      const sumLate = Object.values(c.perUser).reduce((s, u) => s + u.lateMs, 0);
      const sumCharged = Object.values(c.perUser).reduce((s, u) => s + u.chargedMs, 0);
      expect(sumLate).toBe(c.overdueMs);
      expect(sumCharged).toBe(c.accountableMs);
      const excluded = segments.filter((s) => !s.charged).reduce((s, x) => s + (x.endedAt!.getTime() - x.startedAt.getTime()), 0);
      expect(c.accountableMs + excluded).toBe(t); // segments partition the cycle
    }
  });

  it('denormalised overdue matches; completed tasks are never overdue', () => {
    expect(isOverdueDenormalized({ status: 'IN_PROGRESS', chargedMs: 20 * H, budgetMs: 24 * H, clockRunningSince: at(0) }, at(5))).toBe(true);
    expect(isOverdueDenormalized({ status: 'PENDING_REVIEW', chargedMs: 22 * H, budgetMs: 24 * H, clockRunningSince: null }, at(500))).toBe(false);
    expect(isOverdueDenormalized({ status: 'COMPLETED', chargedMs: 99 * H, budgetMs: 24 * H, clockRunningSince: null }, at(500))).toBe(false);
  });
});
