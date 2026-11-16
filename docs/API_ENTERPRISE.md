# Enterprise API (v1) — endpoints added for the Al-Rasiyat platform

All under `/api/v1`, bearer/cookie auth, zod-validated, Swagger at `/api/docs`. **Task visibility (all endpoints):** a task is visible to its creator and approver (project managers must still manage the project; admins need no membership), its assignee and transfer participants. Managers of the same project don't see each other's tasks; the admin role does not grant company-wide task visibility. Admins can be assignees (add them to the project as employee + a department).

Errors share one
shape: `{ statusCode, error, message, code }` with `code` ∈ `VALIDATION_FAILED, UNAUTHENTICATED,
PASSWORD_CHANGE_REQUIRED, FORBIDDEN, NOT_FOUND, CONFLICT, INVALID_STATE, PENDING_EXISTS,
TRANSFER_CHAIN_INVALID, ASSIGNEE_NOT_ELIGIBLE, DEPARTMENT_INACTIVE, RATE_LIMITED, INTERNAL`.
Resources the caller may not see return **404**. Lists are paginated (`page`, `pageSize`).

## Departments
| Method | Path | Who |
| --- | --- | --- |
| GET | `/departments` (`?includeInactive=true` admin) | all |
| POST | `/departments` | ADMIN |
| PATCH | `/departments/:id` (rename, reorder, activate/deactivate) | ADMIN |
| GET | `/departments/:id/members` | ADMIN, PM |
| GET | `/departments/:id/history` | ADMIN |
| GET | `/departments/:id/assignable-employees?projectId=` | ADMIN, project manager |
| PUT | `/users/:id/departments` `{ departments: [{ departmentId, isPrimary }] }` (exactly one primary) | ADMIN |

## Tasks (changed / new)
- `POST /tasks` now requires `departmentId`; optional `priority` (`LOW|MEDIUM|HIGH|URGENT`), `approverId` (ADMIN only).
- `PATCH /tasks/:id` accepts `priority`, `departmentId`; deadline edits update the approved deadline.
- `GET /tasks` filters: `departmentId`, `priority`, views `pending_review`, `to_review`; `overdue` uses the ledger.
- `PATCH /tasks/:id/approver` (ADMIN) · `GET /tasks/:id/time` (ledger per cycle).
- Task DTO adds `department`, `priority`, `approver`, `originalDeadline`, `currentCycle`, `time`, `pending{…}`;
  detail adds `pendingSubmission|Transfer|Extension` and the new `permissions` flags.

## Approval workflow
| Method | Path | Who |
| --- | --- | --- |
| POST | `/tasks/:id/submissions` `{ comment, attachmentIds }` | responsible employee |
| GET | `/tasks/:id/submissions` | task viewers |
| POST | `/submissions/:id/approve` `{ note?, adminReason? }` | approver / ADMIN (reason) |
| POST | `/submissions/:id/reject` `{ reason, adminReason? }` | approver / ADMIN (reason) |
| POST | `/submissions/:id/forward` `{ note?, attachmentIds? }` | delegator |
| POST | `/submissions/:id/return` `{ reason }` | delegator |
| POST | `/submissions/:id/withdraw` | submitter |
| POST | `/tasks/:id/complete` | **deprecated** alias → submits; returns the task |

## Frontend read models
- `GET /me/reviews` — completion review inbox (pending submissions addressed to me, with the task, its department, accountable time and deadlines; never rating data).
- `GET /tasks?view=rejected` — my tasks sent back (rejected/returned) and not yet resubmitted.
- `GET /tasks/:id/time` — each cycle also returns `totals` (active work, transfer pending, colleague review, pending/approved/rejected manager review, completion duration) and `provisional` (true while a manager decision is pending).
- `GET /dashboard` — `totals` adds `inProgressTasks`, `pendingReviewTasks`, `toReview`, `rejectedSubmissions`, `incomingTransfers`, and for admins `employees`, `departments`; managers/admins also get `workload` (open/overdue/pending per employee, no rating data).
- `TransferDto.task` — `{ id, title, projectName }` for the incoming-transfers screen.
- `GET /performance/employees/:id` — adds `departments`.
- `GET /documents/:id/download-url?preview=true` — inline URL **only** for JPEG/PNG/WebP/GIF/PDF (`inline: true`); every other type is always an attachment download.

## Transfers & extensions
| Method | Path | Who |
| --- | --- | --- |
| POST | `/tasks/:id/transfers` `{ toUserId, reason }` | responsible employee |
| GET | `/tasks/:id/transfers` · `/tasks/:id/transfer-candidates` | viewers · responsible |
| POST | `/transfers/:id/accept` · `/decline {reason}` · `/cancel` | recipient · recipient · requester/approver/ADMIN |
| GET | `/me/transfers` | recipient (incoming, pending) |
| POST | `/tasks/:id/extensions` `{ requestedMinutes \| requestedDeadline, reason }` | responsible employee |
| GET | `/tasks/:id/extensions` | viewers |
| POST | `/extensions/:id/decide` `{ decision: APPROVE\|PARTIAL\|REJECT, grantedMinutes?, note? }` | approver / ADMIN |
| POST | `/extensions/:id/cancel` | requester |

## Documents Center
| Method | Path | Who |
| --- | --- | --- |
| GET | `/document-categories` | all |
| GET | `/projects/:id/documents?q&categoryId&source&departmentId&taskId&uploadedById&from&to&sort` | project members (employees: `PROJECT_MEMBERS` only) |
| POST | `/projects/:id/documents/upload-url` → PUT to S3 → `POST /documents/:id/confirm` | project managers |
| GET | `/documents/:id` · `/documents/:id/download-url` | per visibility |
| PATCH | `/documents/:id` · POST `/documents/:id/archive` | project managers |

Approved submission files are registered automatically (reusing the attachment's S3 object).

## Personal tasks (owner only — no role can read another user's)
`GET|POST /me/personal-tasks`, `GET|PATCH|DELETE /me/personal-tasks/:id`, `POST …/:id/complete|reopen`.

## Reports (PDF, rendered by the worker)
`POST /reports` with `{ type: 'TASK', taskId }`, `{ type: 'EMPLOYEE', userId, from, to, projectIds?, departmentId?, status?, priority?, timeliness? }`
or `{ type: 'PROJECTS', projectIds, from, to, … }`, `locale` `ar|en` → `ReportJobDto` (`QUEUED`);
poll `GET /reports/:id`; `GET /reports/:id/download-url` when `READY`; `GET /me/reports`.
20 per user per hour; retained 7 days; report rows are limited to the requester's task scope, and ratings are included only when the requester manages every included task (never their own).

## Accounts
- `POST /users` (ADMIN): `departments`, `projects`, `passwordDelivery` (`EMAIL` Cognito default, `SHOW_ONCE`
  returns `temporaryPassword` once). Users must change the temporary password at first sign-in.
- `POST /users/:id/reset-password` (same delivery options) · `GET /users/:id` · `GET /users/:id/audit`.
- `POST /auth/change-password` `{ currentPassword, newPassword }`; login returns `NEW_PASSWORD_REQUIRED` +
  `session` while a temporary password is in place (complete with `POST /auth/new-password`).
- While `mustChangePassword`, every route except `/auth/me` and `/auth/change-password` → 403 `PASSWORD_CHANGE_REQUIRED`.
- Deactivation disables the identity, revokes Cognito sessions and blocks access immediately.
