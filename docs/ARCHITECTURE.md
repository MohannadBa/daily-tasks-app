# Architecture

## Components

```
        ┌──── Desktop browser · phone browser · installed PWA (Home Screen) ────┐
        │ Next.js web app (/bff proxy, httpOnly cookies, service worker)        │
        └───────────────────────────────┬───────────────────────────────────────┘
                                        │ HTTPS (ALB)
                    ┌───────────────────▼──────────────────────────────────┐
                    │                 NestJS API  (/api/v1)                 │
                    │ AuthGuard → AccessService → services → Prisma ($tx)   │
                    │          writes business rows + OutboxEvent           │
                    └───────┬─────────────────────────┬────────────────────┘
                            │                         │ pre-signed URLs
                    ┌───────▼───────┐          ┌──────▼──────┐
                    │  PostgreSQL   │          │  S3 private │◄── clients PUT/GET directly
                    └───────▲───────┘          └─────────────┘
                            │ poll (SKIP LOCKED)
                    ┌───────┴──────────────────────────────────────────────┐
                    │ Worker: outbox relay ─► SQS ─► consumer ─► notifier   │
                    │         schedule sync ─► EventBridge Scheduler ─► SQS │
                    │  push sender (Expo today; Web Push migration pending) │
                    └──────────────────────────────────────────────────────┘
```

* **Modular monolith.** One API process (modules: auth, access, users, projects, tasks, attachments, ratings, notifications, dashboard, company, health) and one worker process. No microservices, no Redis.
* **Shared packages:** `database` (Prisma + event contracts), `validation` (zod), `config` (constants + env schemas), `shared-types`, `api-client`.

## Authentication
* **Production:** Amazon Cognito user pool (no self sign-up). The API calls `InitiateAuth` (`USER_PASSWORD_AUTH`) on a public app client and returns Cognito tokens; it verifies access tokens with `aws-jwt-verify` (signature, issuer, expiry, `token_use=access`, `client_id`). First login links `cognitoSub` to the user row. Invited users complete the `NEW_PASSWORD_REQUIRED` challenge via `/auth/new-password`. Admin invites call `AdminCreateUser` (Cognito e-mails the temporary password).
* **Local/test:** `AUTH_MODE=local` issues HS256 JWTs and stores bcrypt hashes. Refused when `NODE_ENV=production`.
* Every request reloads the user row, so deactivating a user takes effect immediately.
* **Web:** tokens never reach browser JavaScript. `/session/login` stores them in httpOnly, SameSite=Lax cookies; `/bff/*` proxies to the API, attaches the bearer token, refreshes once on 401, and rejects cross-origin mutations (Origin check).

## Authorization (`AccessService`)
| Role | Access |
|---|---|
| COMPANY_ADMIN | everything in the company; manage users/projects/settings; may rate |
| Project MANAGER (membership) | their projects, all tasks in them, members, ratings for those projects |
| Project EMPLOYEE (membership) | the project, **only tasks assigned to them** |

* Company role (`User.role`) gates portal-level features; project role (`ProjectMembership.role`) gates project data.
* A specific resource the caller may not see returns **404** (not 403) to prevent ID probing.
* Ratings: controller-level `@Roles(ADMIN, PROJECT_MANAGER)` (employees → 403) **plus** task-manager access check. Employee task DTOs never include rating fields.

## Task workflow
`ASSIGNED → IN_PROGRESS → COMPLETED`, reopen `COMPLETED → ASSIGNED`.
* Employee starts explicitly or by commenting. Completion requires a non-empty comment; it is immediate (no approval). `completedAt` and `completedLate` are set inside the completion transaction with a conditional update (prevents double submit/races).
* Reopen records previous completion facts (`previousCompletedAt`, `previousCompletedLate`, reason) in `TaskHistory`; comments/attachments are preserved.
* Ratings are separate from completion. A rating made before a reopen is flagged `needsReview` after re-completion; averages only count tasks currently `COMPLETED`.

## Notifications & reliability
1. API writes the change + `OutboxEvent` (unique `dedupeKey`) in one transaction.
2. Worker relays outbox rows to SQS (`FOR UPDATE SKIP LOCKED`, exponential backoff, `FAILED` after 10 attempts).
3. Consumer handles each message idempotently, then deletes it. Failures are retried by SQS visibility timeout; after 5 receives → DLQ (alarmed).
4. `Notifier` de-duplicates recipients (multi-role users get one notification), excludes the actor, creates `Notification` rows with `skipDuplicates` on `(userId, dedupeKey)`, then pushes rows whose `pushedAt` is null to every active device — so retries never duplicate rows and only re-push what failed.
5. Expo Push (→ APNs/FCM). `DeviceNotRegistered` at ticket or receipt time disables the device. Receipts are checked ~15 min later (`PushTicket`).
6. Push payload `data.url = dailytasks://tasks/<id>` (becomes `/tasks/<id>` with Web Push; the web app already deep-links every screen, see docs/PWA.md). In-app notification list works even if push fails. OS delivery timing is not guaranteed.

| Event | Recipients |
|---|---|
| TASK_ASSIGNED, TASK_UPDATED, TASK_REOPENED, TASK_DEADLINE_APPROACHING | assignee |
| TASK_REASSIGNED | new assignee + previous assignee (different text) |
| TASK_COMMENT_ADDED | employee comment → project managers; manager comment → assignee |
| TASK_COMPLETED | project managers |
| TASK_OVERDUE | assignee + project managers |

Messages are rendered in the recipient's locale (`en`/`ar`).

## Deadline scheduling
* Any deadline-related change (create, deadline edit, complete, reopen, reminder settings change) increments `Task.scheduleVersion` and enqueues `TASK_SCHEDULE_SYNC`.
* Worker computes jobs: one reminder per company offset (default 24 h and 1 h, configurable up to 5) plus `OVERDUE` at the deadline. Past reminders are skipped.
* **Production:** EventBridge Scheduler one-time schedules (`at(...)`, `ActionAfterCompletion=DELETE`) named `t-<task>-v<version>-<kind>` in a per-environment group, targeting the SQS queue. Old versions are deleted (best effort).
* **Local:** `ScheduledEvent` table polled by the worker.
* On delivery the worker re-reads the task: stale version, completed or archived → ignored. A task completed before its deadline can therefore never be reported overdue, regardless of processing delay.

## Files
Pre-signed PUT with signed `Content-Type` and `Content-Length` → `POST /attachments/:id/confirm` (HeadObject verifies existence and exact size) → linked to a comment/completion. Keys are random (`tasks/<taskId>/<uuid>`); file names are only metadata. Downloads are short-lived pre-signed GETs with `Content-Disposition: attachment`, issued only after task access is checked. Allow-list of MIME types + extension match, 25 MB per file, max 10 per request.

## Internationalisation
Web portal: English/Arabic with full RTL (`dir="rtl"` from a cookie on first render, logical Tailwind utilities, Gregorian Arabic dates). The language choice also updates the user's profile locale, which drives push/in-app notification language.
