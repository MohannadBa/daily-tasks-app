# CLAUDE.md — DailyTasks

Guidance for AI agents and engineers working in this repository.

## What this is
Company task-management platform: managers assign tasks to employees (one assignee per task), employees reply/attach files and complete tasks from the mobile app, managers privately rate completed work (1–5 stars). Modular monolith: **NestJS API** + separate **worker**, **Next.js** manager portal, **Expo** mobile app (not built yet), **PostgreSQL/Prisma**, AWS (Cognito, S3, SQS, EventBridge Scheduler, ECS Fargate, RDS) via **CDK**.

## Layout
```
apps/api            NestJS REST API (/api/v1, Swagger /api/docs)
apps/worker         Outbox relay, SQS consumer, notifications + Expo push, deadline scheduler
apps/web            Next.js 15 portal (App Router, Tailwind 4, BFF proxy at /bff, en/ar + RTL)
apps/mobile         Expo app — placeholder package only (scripts stubbed; see scriptsWhenImplemented)
packages/database   Prisma schema, migrations, seed, outbox event contracts
packages/config     Product constants + zod env schemas (api/worker)
packages/validation zod request schemas shared by API and clients
packages/shared-types DTO/enum types
packages/api-client typed fetch client (web + mobile)
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
pnpm cdk:synth               # synth only; NEVER deploy without explicit human approval
```
Demo logins (seed, local only): `manager1@dailytasks.local` / `employee1@dailytasks.local` / `admin@dailytasks.local`, password `Password123!`.

## Non-negotiable rules
1. **Authorization lives in `apps/api/src/access/access.service.ts`.** Every endpoint that touches a project/task must go through it. Unauthorized access to a specific resource returns **404** (IDOR-safe). Memberships are read from the DB per request (removal is immediate).
2. **Ratings are private.** Employees must never receive stars, averages or feedback from any endpoint. Rating routes are `@Roles(COMPANY_ADMIN, PROJECT_MANAGER)` *and* check task-manager access. `toTaskDto(task, includeRating)` must get `false` for employees. Rating audit lives in `TaskRatingRevision`, never in `TaskHistory` (employee-visible).
3. **Averages are computed**, never stored: ratings whose task is currently `COMPLETED`.
4. **Side effects go through the outbox** (`OutboxService`) inside the same `$transaction` as the change. Never call SQS/push from the API request path.
5. **Deadline correctness:** `completedAt`/`completedLate` are fixed at completion inside the transaction. Any deadline-related change increments `Task.scheduleVersion` and enqueues `TASK_SCHEDULE_SYNC`; the worker ignores events whose version is stale and re-checks DB state before notifying.
6. **Idempotency:** notifications are unique on `(userId, dedupeKey)`; outbox rows on `dedupeKey`.
7. **Files:** never store binaries in Postgres. Pre-signed PUT (type + size signed) → `confirm` (HeadObject check) → link to comment. Allowed types in `packages/config`.
8. **Never log tokens, passwords or secrets.** Env validation errors list keys only.
9. Completion requires a non-empty comment (validated in zod schema + API).

## Conventions
- Validation: zod schemas in `packages/validation`; use `ZBody/ZQuery` + `ApiZodBody` in controllers.
- New domain event: add to `OutboxEventType` (packages/database/src/events.ts), handle in `apps/worker/src/processor.ts`, add EN+AR text in `apps/worker/src/messages.ts`.
- Schema change: edit `schema.prisma`, `npx prisma migrate dev --name <x>` in packages/database (DATABASE_URL → localhost:5433), add CHECK constraints by hand when needed.
- Web strings: wrap in `t('English text')` from `useT()` and add the Arabic entry in `apps/web/src/lib/i18n.tsx`. Use logical Tailwind classes (`ms-/me-/ps-/pe-/start-/end-/text-start`), never `ml-/mr-/left-/right-`.
- Tests: API integration tests in `apps/api/test/*.e2e-spec.ts` (real Postgres, fake S3); worker tests in `apps/worker/test`.

## AWS
Do not run `cdk deploy`, `push-images.sh`, or create any AWS resources unless the human explicitly approves. See docs/DEPLOYMENT.md.
