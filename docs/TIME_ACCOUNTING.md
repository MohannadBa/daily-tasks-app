# Time accounting, approval workflow and delegation

Source of truth: `packages/database/src/time-ledger.ts` (pure engine, unit-tested), applied by
`apps/api/src/workflow/time-ledger.service.ts` inside the same transaction as every state change.
Design decisions: `docs/plans/ENTERPRISE_PLATFORM_PLAN.md` (D-1 … D-15).

## Model

A task has one or more **cycles** (`TaskCycle`; a reopen starts a new one). Each cycle has:

- `originalDeadline` — the deadline when the cycle started (never changes),
- `approvedDeadline` — the official deadline (moves only by manager edit or an approved extension),
- **budget** = `approvedDeadline − cycle.startedAt`,
- an append-only list of **segments** (`TaskTimeSegment`), exactly one open at a time.

| Segment kind | While open | Closed as |
| --- | --- | --- |
| `ACTIVE_WORK` | clock runs, responsible employee | charged to the responsible employee |
| `TRANSFER_PENDING` | clock runs (requester still responsible) | charged to the requester |
| `DELEGATOR_REVIEW` | clock runs (delegator reviewing a delegate's work) | charged to the delegator (forward) or the delegate (return) |
| `PENDING_REVIEW` | **clock paused** (waiting for the approver) | → `APPROVED_REVIEW` (excluded) or `REJECTED_REVIEW` (charged to the submitter) |

**Accountable time** = sum of charged closed segments + the running open segment.
**Overdue** ⇔ the task is not completed and accountable time **>** budget (strict).

### Required examples (tests: `packages/database/test/time-ledger.test.ts`, `apps/api/test/enterprise.e2e-spec.ts`)

- 22 h work → submit → 8 h manager review → **approved** ⇒ accountable 22 h (on time vs 24 h).
- 22 h work → submit → 6 h manager review → **rejected** ⇒ accountable 28 h (late 4 h); the 6 h
  are charged to the submitter. A later approval keeps 28 h and `completedLate = true`.
- A wall-clock deadline that passes while the clock is paused does not make the task overdue.

### Denormalised clock (fast lists, reminders)

`Task.budgetMs`, `chargedMs`, `clockRunningSince`, `effectiveDueAt` are recomputed by
`TimeLedgerService.sync()` after every transition, which also bumps `scheduleVersion` and enqueues
`TASK_SCHEDULE_SYNC`. `effectiveDueAt` = the moment accountable time reaches the budget if the clock
keeps running (null while paused). The worker schedules reminders/overdue at `effectiveDueAt` and
re-checks the denormalised clock on delivery; one overdue alert per cycle.

DB constraints guard the invariants: one open segment per task, closed segments immutable (trigger),
PENDING_REVIEW ⇔ `pendingSubmissionId`, running clock ⇔ `effectiveDueAt`, non-negative times.
All timestamps come from the database (`SELECT now()`) inside the transaction.

## Approval workflow

`ASSIGNED → IN_PROGRESS → PENDING_REVIEW → COMPLETED`; rejection, return and withdrawal go back to
`IN_PROGRESS`; reopen (manager) starts a new cycle. Only `POST /submissions/:id/approve` completes a
task (`POST /tasks/:id/complete` is a deprecated alias that **submits**).

- Submission: responsible employee, mandatory comment, optional files; immutable once decided (trigger).
- Approver = `Task.approverId` (creator by default; ADMIN can change it). An ADMIN who is not the
  approver may decide with a mandatory `adminReason` (audited, `decidedAsAdmin`, approver notified).
- Nobody who worked on the submission (the chain) can decide on it.
- Every decision is a conditional claim (`UPDATE … WHERE status = 'PENDING'`): concurrent decisions
  yield exactly one success and `409` for the others.
- On approval: cycle snapshot (accountable, budget, late), `completedAt/completedLate` fixed, files of
  the approved submission chain registered as project documents (same S3 object, `MANAGERS_ONLY`).

## Transfers (delegation chain)

`A → B → …` (max 3 hops). Rules: reason required; recipient must accept; recipient must be an
active employee of the task's project **and** department, not already in the active chain (no
circular transfers), not the approver. While a transfer is pending, the requester stays responsible
(time charged to them). On acceptance the recipient becomes responsible; earlier holders remain
participants (can view). The original/approved deadlines are never reset by a transfer.

A delegate's submission is reviewed by **its delegator** (`stage = DELEGATOR`): forward (the work
moves up the chain; the delegator becomes the submitter at the next level) or return (reason
required; review time charged to the delegate). Only a manager-stage submission reaches the approver.
Manager rejection of forwarded work returns it to the accountable employee A (D-4), who may delegate
again. The rating subject is the accountable employee (D-5).

## Deadline extensions

The responsible employee requests minutes (15 min – 30 days) or a new deadline, with a reason; one
pending request per task. The approver (or audited ADMIN) approves fully, partially (less than
requested) or rejects (note required). Approved minutes extend `approvedDeadline` (budget grows,
reminders rescheduled); `originalDeadline` is preserved. Every request and decision is kept.
