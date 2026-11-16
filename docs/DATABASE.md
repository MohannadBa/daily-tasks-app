# Database design

PostgreSQL 16 via Prisma 6. Schema: `packages/database/prisma/schema.prisma`; migrations in `packages/database/prisma/migrations`. All primary keys are UUIDs; all timestamps are `timestamptz(3)` with `createdAt`/`updatedAt`.

## Entities

| Model | Purpose | Key constraints |
|---|---|---|
| Company | The single tenant; timezone, reminder offsets (`Int[]`, default `{1440,60}`) | |
| User | Person with company role (`COMPANY_ADMIN`/`PROJECT_MANAGER`/`EMPLOYEE`), locale, `isActive`, `cognitoSub` | `email` unique, `cognitoSub` unique |
| Project | Active/archived project | index `(companyId,status)` |
| ProjectMembership | User's role in a project (`MANAGER`/`EMPLOYEE`); soft-removed with `removedAt` | unique `(projectId,userId)` |
| Task | One project, one assignee; status, deadline, completion facts, `reopenCount`, `scheduleVersion` | CHECK completion consistency; indexes `(projectId,status)`, `(assigneeId,status)`, `(status,deadline)` |
| TaskComment | Replies; `isCompletionNote` marks the completion report | index `(taskId,createdAt)` |
| TaskAttachment | File metadata (`PENDING`→`UPLOADED`), optional `commentId` | `storageKey` unique; CHECK size 1 B–25 MB |
| TaskRating | One rating per completed task; private feedback | `taskId` unique; CHECK stars 1–5 |
| TaskRatingRevision | Audit trail of rating create/edit (previous/new stars & feedback) | CHECK stars 1–5 |
| TaskHistory | Employee-visible task timeline (created, updated, deadline changed, reassigned, started, commented, attachment, completed, reopened) | index `(taskId,createdAt)` |
| Notification | Persistent in-app notification; `pushedAt` tracks push delivery | unique `(userId,dedupeKey)` |
| DeviceInstallation | Expo push token per device (multiple per user); `disabledAt` when invalid | `expoPushToken` unique |
| PushTicket | Expo ticket awaiting receipt check | `ticketId` unique |
| OutboxEvent | Transactional outbox (`PENDING`/`PUBLISHED`/`FAILED`, attempts, backoff) | `dedupeKey` unique; index `(status,availableAt)` |
| ScheduledEvent | Local-dev substitute for EventBridge schedules | `name` unique |

## Design decisions
* **Rating average is never stored.** It is `AVG(stars)` over `TaskRating` rows whose task is currently `COMPLETED` (and within the caller's authorized projects). Unrated tasks are excluded automatically.
* **Rating audit is separate from task history** so that no employee-visible endpoint can leak rating data.
* **Completion facts are immutable per completion.** `completedLate` is computed once in the completion transaction; a CHECK constraint guarantees `COMPLETED ⇔ completedAt & completedLate NOT NULL`. On reopen they are cleared on the task and preserved in `TaskHistory.metadata`.
* **`scheduleVersion`** invalidates previously scheduled deadline events without needing to delete them first.
* **Soft membership removal** keeps history and assignments intact while revoking access immediately (all checks filter `removedAt IS NULL`).
* **Deletion/archival:** business records use `onDelete: Restrict` (tasks, comments, attachments, ratings are never cascaded away). Projects are archived (`status=ARCHIVED`, `archivedAt`), users deactivated (`isActive=false`), tasks have `archivedAt`. Only per-user ephemera (notifications, devices) cascade on user deletion.
* **Binary files are never stored in Postgres** — only S3 keys and metadata.

## Migrations & seed
```bash
cd packages/database
DATABASE_URL=postgresql://dailytasks:dailytasks@localhost:5433/dailytasks npx prisma migrate dev --name <change>
pnpm db:migrate      # prisma migrate deploy
pnpm db:seed         # idempotent demo data (refuses in production unless SEED_ALLOW_PRODUCTION=true)
```
Hand-written SQL (CHECK constraints) lives at the end of the initial migration.
