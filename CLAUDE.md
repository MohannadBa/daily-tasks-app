# CLAUDE.md — DailyTasks

Guidance for AI agents and engineers working in this repository.

## What this is
Company task-management platform: managers assign tasks to employees (one assignee per task), employees reply/attach files and complete tasks from their phones, managers privately rate completed work (1–5 stars). Modular monolith: **NestJS API** + separate **worker**, one **Next.js** web app for every role and device (responsive, installable **PWA**; there is **no native mobile app**), **PostgreSQL/Prisma**, AWS (Cognito, S3, SQS, EventBridge Scheduler, ECS Fargate, RDS) via **CDK**.

## Layout
```
apps/api            NestJS REST API (/api/v1, Swagger /api/docs)
apps/worker         Outbox relay, SQS consumer, notifications + Web Push (VAPID, web-push), deadline scheduler
apps/web            Next.js 15 web app + PWA (App Router, Tailwind 4, BFF proxy at /bff, en/ar + RTL, manifest, public/sw.js)
                    pages: dashboard, projects (overview/tasks/employees/documents), tasks, reviews (inbox), transfers,
                    personal, documents, departments, reports, users (Administration), employees, notifications, settings
packages/database   Prisma schema, migrations, seed, outbox event contracts
packages/config     Product constants + zod env schemas (api/worker)
packages/validation zod request schemas shared by API and clients
packages/shared-types DTO/enum types
packages/api-client typed fetch client (web app)
infrastructure/aws-cdk  Registry + staging/production stacks
docker/             Dockerfiles, LocalStack + Postgres init
scripts/            docker-smoke-test.mjs, push-images.sh
```

## Commands
```bash
pnpm install
pnpm build:packages          # must run before typecheck/tests of apps (apps consume packages' dist/)
docker compose up -d --build # postgres(5433) localstack(4566) migrate api(3000) worker web(3001)
pnpm test                    # needs compose postgres running (tests use dailytasks_test DB)
pnpm lint && pnpm typecheck
pnpm test:docker             # end-to-end smoke test against the running compose stack (~75s)
scripts/deploy-production.sh check|…|deploy   # production-first deploy driven by .env.production (docs/PRODUCTION_PLAN.md); asks before every AWS change
scripts/deploy-staging.sh check|…|deploy      # optional staging (docs/STAGING_PLAN.md, superseded)
node scripts/cognito-staging-test.mjs   # Cognito verification against a deployed staging API (env vars in docs/COGNITO_TESTS.md)
pnpm cdk:synth               # synth registry+staging; production needs HTTPS context (synth:production). NEVER deploy without explicit human approval
```
Demo logins (seed, local only): `manager1@dailytasks.local` / `employee1@dailytasks.local` / `admin@dailytasks.local`, password `Password123!`.

## Non-negotiable rules
1. **Authorization lives in `apps/api/src/access/access.service.ts`.** Every endpoint that touches a project/task must go through it. Unauthorized access to a specific resource returns **404** (IDOR-safe). Memberships are read from the DB per request (removal is immediate).
   **Task visibility (company rule):** a task is *managed* by its creator and its approver only (`managedTaskScope` / `managesTask`; PMs must still manage the project). Everyone else sees a task only as its assignee or a transfer participant (`taskScope`). Managers of the same project do **not** see each other's tasks, and **ADMIN does not grant company-wide task visibility** (admins keep account/department/project administration). Admins may be assignees (added to the project as EMPLOYEE). Every list, dashboard, rating/performance figure, report dataset, task-sourced document and notification must use these scopes — never `projectId in managed projects`. Ratings: `canSeeRating` (managers of the task, never its assignee).
2. **Ratings are private.** Employees must never receive stars, averages or feedback from any endpoint. Rating routes are `@Roles(ADMIN, PROJECT_MANAGER)` *and* check task-manager access. `toTaskDto(task, includeRating)` must get `false` for employees. Rating audit lives in `TaskRatingRevision`, never in `TaskHistory` (employee-visible).
3. **Averages are computed**, never stored: ratings whose task is currently `COMPLETED`.
4. **Side effects go through the outbox** (`OutboxService`) inside the same `$transaction` as the change. Never call SQS/push from the API request path.
5. **Deadline correctness:** `completedAt`/`completedLate` are fixed at completion inside the transaction. Any deadline-related change increments `Task.scheduleVersion` and enqueues `TASK_SCHEDULE_SYNC`; the worker ignores events whose version is stale and re-checks DB state before notifying.
6. **Idempotency:** notifications are unique on `(userId, dedupeKey)`; outbox rows on `dedupeKey`.
7. **Files:** never store binaries in Postgres. Pre-signed PUT (type + size signed) → `confirm` (HeadObject check) → link to comment. Allowed types in `packages/config`.
8. **Never log tokens, passwords or secrets.** Env validation errors list keys only.
9. Completion requires a non-empty comment (validated in zod schema + API).
10. **Only approval completes a task.** Employees submit (`TaskSubmission`, immutable once decided); the approver (`Task.approverId`) or an ADMIN with an audited `adminReason` decides. Nobody in the submission chain decides on it. Decisions are conditional claims (`updateMany … status: 'PENDING'`) → concurrent duplicates get 409. See docs/TIME_ACCOUNTING.md.
11. **Time ledger:** every workflow transition calls `TimeLedgerService.switch()` + `sync()` in the same transaction (DB `now()`). Overdue = accountable time > budget, never the wall-clock deadline. Closed segments are immutable (DB trigger); never edit them.
12. **Personal tasks are owner-only** (no role exception, admins included), AES-256-GCM encrypted with `PERSONAL_DATA_KEY`, and never appear in tasks, dashboards, reports, documents or notifications.
13. **Reports:** the API builds the authorized dataset (rating data only when `includesRatings`); the worker only renders it (Chromium) and drops the dataset afterwards. Reports are private to their requester.
14. **Accounts:** only ADMIN provisions users; temporary passwords are hashed/held by Cognito, returned at most once (SHOW_ONCE) and never logged or audited; `mustChangePassword` blocks every route except `@AllowWhilePasswordChangeRequired()`.

## Conventions
- Validation: zod schemas in `packages/validation`; use `ZBody/ZQuery` + `ApiZodBody` in controllers.
- New domain event: add to `OutboxEventType` (packages/database/src/events.ts), handle in `apps/worker/src/processor.ts`, add EN+AR text in `apps/worker/src/messages.ts`.
- Schema change: edit `schema.prisma`, `npx prisma migrate dev --name <x>` in packages/database (DATABASE_URL → localhost:5433), add CHECK constraints by hand when needed.
- Brand/design: tokens in `apps/web/src/app/globals.css` (gold #C0903D from the logo, see docs/DESIGN_SYSTEM.md). Use the tokens/components (`brand-*`, `success/warning/danger/info-*`, `Button`, `Card`, `Skeleton`, `useFeedback()` toasts/confirm); never ad-hoc colours. White text only on `brand-600`+. App name: الراسيات / Al-Rasiyat.
- Arabic is the default locale; all dates display in Asia/Riyadh and typed deadlines are Riyadh time (`lib/format.ts`); store/transport UTC.
- Real-time: worker `publishRealtime()` → `pg_notify('dt_realtime')` → API `RealtimeService` → WebSocket `/api/v1/realtime`. Payloads are ids/types only; clients refetch. Never put task content or rating data on the socket.
- Web strings: wrap in `t('English text')` from `useT()` and add the Arabic entry in `apps/web/src/lib/i18n.tsx` (enforced by `src/lib/i18n-coverage.test.ts`). Use logical Tailwind classes (`ms-/me-/ps-/pe-/start-/end-/text-start`), never `ml-/mr-/left-/right-`.
- Push (see docs/PUSH_NOTIFICATIONS.md): Web Push only. Pipeline = outbox → SQS → worker `Notifier` (history row first, then one `PushDelivery` per subscription; never push from the API). VAPID private key is worker-only (Secrets Manager), never in DB/API/logs. Subscription endpoints, p256dh and auth are never returned by the API or logged (log the host only). New push endpoints must pass `isAllowedPushEndpoint` (SSRF). Never request notification permission except from the explicit Enable button. A 2xx from the push service is not proof of display.
- PWA (see docs/PWA.md): `src/app/manifest.ts`, `public/sw.js` (bump `VERSION` on policy/precache changes), `public/offline.html`, `src/lib/pwa.ts`. The service worker must **never cache authenticated HTML or `/bff`/`/session` responses**. New public files that must load signed-out (icons, manifest, SW) need excluding in the `middleware.ts` matcher. Keep `htmlLimitedBots: /.*/` in `next.config.ts` (otherwise metadata streams into `<body>` and iOS/Chrome ignore the manifest + apple tags). Regenerate icons with `node scripts/generate-icons.mjs` in apps/web.
- Business time on the web: never compute it client-side; show `task.time` and `GET /tasks/:id/time` (`totals`, `provisional`) only.
- Mobile UI: phones (< lg) get the top app bar + bottom tab bar + "More" sheet in `components/app-shell.tsx`, desktop keeps the sidebar. Use `min-h-11`/16px inputs for touch, card lists instead of tables below `md`, `env(safe-area-inset-*)` for fixed bars, and check 390 px width in EN and AR (no horizontal overflow).
- Production requires HTTPS (CDK errors without a certificate/domain). Do not weaken that: phones need HTTPS for the service worker, install and push.
- Web → API calls must forward the client IP with `clientIpHeaders(req)` (apps/web/src/lib/client-ip.ts); otherwise per-IP throttling lumps all users together. Behind CloudFront (no custom domain) both `CLIENT_IP_PROXY_HOPS` (web) and `TRUST_PROXY_HOPS` (api) are 2 — keep them equal.
- Do not claim production readiness until docs/REAL_DEVICE_TESTS.md is completed on physical devices.
- Browser E2E: `pnpm --filter @dailytasks/web test:e2e` (Playwright with installed Chrome) against the running compose stack.
- Tests: API integration tests in `apps/api/test/*.e2e-spec.ts` (real Postgres, fake S3); worker tests in `apps/worker/test`.

## Production launch gate & ops
- `ACCESS_MODE=restricted` + `ACCESS_ALLOWLIST` (`apps/api/src/auth/access-gate.ts`): enforced in AuthGuard, IdentityService (login/challenge/refresh/forgot), RealtimeService and user provisioning. Production defaults to restricted; opening is an explicit redeploy. Never add an endpoint that bypasses the guard.
- Cognito e-mail goes through SES (`DailyTasks-Mail` stack, deploy + verify first). WAF on the ALB in production; WAF logs must keep `authorization`/`cookie` redacted.
- Backups: production replicates RDS automated backups to **eu-west-1** (14 days) with the KMS key from the `DailyTasks-DR` stack (`production:backupReplicaKmsKeyArn`); `DeleteAutomatedBackups=false`. Never add automatic deletion of backups, snapshots, the DR key or the DR stack.
- Secret names: `dailytasks-<env>/db`, `dailytasks-<env>/personal-data-key`, `dailytasks-production/vapid-private-key`.
- Read-only ops commands in the API image: `db-tls-check.js`, `verify-restore.js` (with `DB_HOST_OVERRIDE=*.rds.amazonaws.com`), plus `bootstrap-admin.js`, `rekey-personal.js`.

## AWS
Do not run `cdk deploy`, `push-images.sh`, or create any AWS resources unless the human explicitly approves. See docs/DEPLOYMENT.md.
