# Database design

PostgreSQL 16 via Prisma 6. Schema: `packages/database/prisma/schema.prisma`; migrations in `packages/database/prisma/migrations`. All primary keys are UUIDs; all timestamps are `timestamptz(3)` with `createdAt`/`updatedAt`.

## Entities

| Model | Purpose | Key constraints |
|---|---|---|
| Company | The single tenant; timezone, reminder offsets (`Int[]`, default `{1440,60}`) | |
| User | Person with company role (`ADMIN`/`PROJECT_MANAGER`/`EMPLOYEE`), locale, `isActive`, `cognitoSub` | `email` unique, `cognitoSub` unique |
| Project | Active/archived project | index `(companyId,status)` |
| ProjectMembership | User's role in a project (`MANAGER`/`EMPLOYEE`); soft-removed with `removedAt` | unique `(projectId,userId)` |
| Task | One project, one assignee; status, deadline, completion facts, `reopenCount`, `scheduleVersion` | CHECK completion consistency; indexes `(projectId,status)`, `(assigneeId,status)`, `(status,deadline)` |
| TaskComment | Replies; `isCompletionNote` marks the completion report | index `(taskId,createdAt)` |
| TaskAttachment | File metadata (`PENDING`→`UPLOADED`), optional `commentId` | `storageKey` unique; CHECK size 1 B–25 MB |
| TaskRating | One rating per completed task; private feedback | `taskId` unique; CHECK stars 1–5 |
| TaskRatingRevision | Audit trail of rating create/edit (previous/new stars & feedback) | CHECK stars 1–5 |
| TaskHistory | Employee-visible task timeline (created, updated, deadline changed, reassigned, started, commented, attachment, completed, reopened) | index `(taskId,createdAt)` |
| Notification | Persistent in-app notification; `pushedAt` tracks push delivery | unique `(userId,dedupeKey)` |
| PushSubscription | Browser Web Push subscription (multiple per user): endpoint, p256dh, auth, platform, `isActive`, expiry/failure/deactivation facts. VAPID keys are not stored. | `endpoint` unique; CHECK endpoint/key lengths, inactive ⇒ `deactivatedAt` |
| PushDelivery | One push attempt record per (notification, subscription): status, attempts, push-service status code | unique `(notificationId,subscriptionId)`; CHECK `SENT ⇔ sentAt` |
| OutboxEvent | Transactional outbox (`PENDING`/`PUBLISHED`/`FAILED`, attempts, backoff) | `dedupeKey` unique; index `(status,availableAt)` |
| ScheduledEvent | Local-dev substitute for EventBridge schedules | `name` unique |
| Department | Company department (Arabic + English name, code, active flag, order) | unique `(companyId,code)`, `(companyId,nameAr)` |
| DepartmentMembership | User ↔ department (many-to-many), exactly one primary, soft-removed | unique `(departmentId,userId)`; partial unique one primary per user |
| TaskCycle | One work cycle per task (new cycle on reopen): original/approved deadline, approval snapshot (accountable, budget, late) | unique `(taskId,cycleNo)`; snapshot all-or-nothing CHECK |
| TaskTimeSegment | Append-only time ledger (`ACTIVE_WORK`, `TRANSFER_PENDING`, `DELEGATOR_REVIEW`, `PENDING_REVIEW`, `APPROVED_REVIEW`, `REJECTED_REVIEW`), charged-to employee | one open segment per task (partial unique); closed rows immutable (trigger); charge-consistency CHECKs |
| TaskSubmission | Completion submission (comment, files via comment), stage `DELEGATOR`/`MANAGER`, decision + reason, forward chain | one pending per task; immutable once decided (trigger); reason required for reject/return |
| TaskTransfer | Delegation hop A→B with reason, status, depth 1–3, closure | one pending per task; not to self; depth CHECK |
| DeadlineExtensionRequest | Requested/granted minutes, previous/new deadline, decision | one pending per task; minutes/decision CHECKs |
| DocumentCategory / ProjectDocument | Documents Center; task-sourced documents reference the attachment (same S3 object), manual uploads have their own key | `attachmentId` unique, `storageKey` unique; source/size CHECKs |
| PersonalTask | Owner-only personal task; title/notes AES-256-GCM encrypted (`titleEnc`, `notesEnc`) bound to the owner | cascade on owner deletion only |
| ReportJob | PDF report job; authorized dataset (dropped after rendering), S3 key, expiry (7 days) | index `(requestedById,createdAt)` |
| AuditLog | Administrative audit (accounts, departments, documents); never secrets | index `(entityType,entityId,createdAt)` |

Task also gained `departmentId`, `priority`, `approverId`, `originalDeadline`, `currentCycle` and the denormalised clock (`budgetMs`, `chargedMs`, `clockRunningSince`, `effectiveDueAt`, `pending*Id`) with CHECKs `PENDING_REVIEW ⇔ pendingSubmissionId` and `running clock ⇔ effectiveDueAt`. Rules: [TIME_ACCOUNTING.md](TIME_ACCOUNTING.md).

## Design decisions
* **Rating average is never stored.** It is `AVG(stars)` over `TaskRating` rows whose task is currently `COMPLETED` (and within the caller's authorized projects). Unrated tasks are excluded automatically.
* **Rating audit is separate from task history** so that no employee-visible endpoint can leak rating data.
* **Completion facts are immutable per completion.** `completedLate` is computed once in the completion transaction; a CHECK constraint guarantees `COMPLETED ⇔ completedAt & completedLate NOT NULL`. On reopen they are cleared on the task and preserved in `TaskHistory.metadata`.
* **`scheduleVersion`** invalidates previously scheduled deadline events without needing to delete them first.
* **Soft membership removal** keeps history and assignments intact while revoking access immediately (all checks filter `removedAt IS NULL`).
* **Deletion/archival:** business records use `onDelete: Restrict` (tasks, comments, attachments, ratings are never cascaded away). Projects are archived (`status=ARCHIVED`, `archivedAt`), users deactivated (`isActive=false`), tasks have `archivedAt`. Only per-user ephemera (notifications, push subscriptions/deliveries) cascade on user deletion.
* **Binary files are never stored in Postgres** — only S3 keys and metadata.

## Enterprise migrations
`20261117090000_enterprise_enums` (role rename `COMPANY_ADMIN→ADMIN`, `PENDING_REVIEW`, new enums), `20261117090100_enterprise_workflow` (tables, backfill of approver/original deadline, constraints, triggers, default departments + document categories per company), `20261117090200_report_projects`. After `migrate deploy` the entrypoint runs `node packages/database/dist/backfill.js`, which builds the time ledger for pre-existing tasks idempotently and verifies it. Validation: `prisma validate`, `prisma migrate status`, and `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` (0 = no drift).

## Migrations & seed
```bash
cd packages/database
DATABASE_URL=postgresql://dailytasks:dailytasks@localhost:5433/dailytasks npx prisma migrate dev --name <change>
pnpm db:migrate      # prisma migrate deploy
pnpm db:seed         # idempotent demo data (refuses in production unless SEED_ALLOW_PRODUCTION=true)
```
Hand-written SQL (CHECK constraints) lives at the end of the initial migration.
