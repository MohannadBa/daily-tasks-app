import { taskTime } from '../workflow/time-ledger.service';

const H = 3_600_000;
describe('taskTime (ledger-based overdue)', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  const base = { budgetMs: BigInt(24 * H), chargedMs: BigInt(0), clockRunningSince: null as Date | null, effectiveDueAt: null as Date | null };

  it('is overdue when accountable time strictly exceeds the budget while running', () => {
    const t = { ...base, status: 'IN_PROGRESS', chargedMs: BigInt(20 * H), clockRunningSince: new Date(now.getTime() - 5 * H) };
    const r = taskTime(t, null, now);
    expect(r.accountableMs).toBe(25 * H);
    expect(r.overdue).toBe(true);
    expect(r.overdueMs).toBe(H);
  });
  it('is not overdue exactly at the budget (strict)', () => {
    const r = taskTime({ ...base, status: 'IN_PROGRESS', chargedMs: BigInt(24 * H) }, null, now);
    expect(r.overdue).toBe(false);
  });
  it('pauses while pending review (no running clock)', () => {
    const r = taskTime({ ...base, status: 'PENDING_REVIEW', chargedMs: BigInt(22 * H) }, null, now);
    expect(r.paused).toBe(true);
    expect(r.overdue).toBe(false);
  });
  it('is never overdue when completed; uses the approval snapshot', () => {
    const r = taskTime({ ...base, status: 'COMPLETED', chargedMs: BigInt(30 * H) }, { accountableMs: BigInt(30 * H), budgetMs: BigInt(24 * H), lateMs: BigInt(6 * H) }, now);
    expect(r.overdue).toBe(false);
    expect(r.overdueMs).toBe(6 * H);
  });
});
