# CLAUDE.md — DailyTasks

Guidance for AI agents and engineers working in this repository.

## What this is
Company task-management platform: managers assign tasks to employees (one assignee per task), employees reply/attach files and complete tasks from their phones, managers privately rate completed work (1–5 stars). Modular monolith: **NestJS API** + separate **worker**, one **Next.js** web app for every role and device (responsive, installable **PWA**; there is **no native mobile app**), **PostgreSQL/Prisma**, AWS (Cognito, S3, SQS, EventBridge Scheduler, ECS Fargate, RDS) via **CDK**.

## Layout
```
apps/api            NestJS REST API (/api/v1, Swagger /api/docs)
apps/worker         Outbox relay, SQS consumer, notifications + Web Push (VAPID, web-push), deadline scheduler
apps/web            Next.js 15 web app + PWA (App Router, Tailwind 4, BFF proxy at /bff, en/ar + RTL, manifest, public/sw.js)
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
pnpm cdk:synth               # synth registry+staging; production needs HTTPS context (synth:production). NEVER deploy without explicit human approval
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
- Brand/design: tokens in `apps/web/src/app/globals.css` (gold #C0903D from the logo, see docs/DESIGN_SYSTEM.md). Use the tokens/components (`brand-*`, `success/warning/danger/info-*`, `Button`, `Card`, `Skeleton`, `useFeedback()` toasts/confirm); never ad-hoc colours. White text only on `brand-600`+. App name: الراسيات / Al-Rasiyat.
- Arabic is the default locale; all dates display in Asia/Riyadh and typed deadlines are Riyadh time (`lib/format.ts`); store/transport UTC.
- Real-time: worker `publishRealtime()` → `pg_notify('dt_realtime')` → API `RealtimeService` → WebSocket `/api/v1/realtime`. Payloads are ids/types only; clients refetch. Never put task content or rating data on the socket.
- Web strings: wrap in `t('English text')` from `useT()` and add the Arabic entry in `apps/web/src/lib/i18n.tsx`. Use logical Tailwind classes (`ms-/me-/ps-/pe-/start-/end-/text-start`), never `ml-/mr-/left-/right-`.
- Push (see docs/PUSH_NOTIFICATIONS.md): Web Push only. Pipeline = outbox → SQS → worker `Notifier` (history row first, then one `PushDelivery` per subscription; never push from the API). VAPID private key is worker-only (Secrets Manager), never in DB/API/logs. Subscription endpoints, p256dh and auth are never returned by the API or logged (log the host only). New push endpoints must pass `isAllowedPushEndpoint` (SSRF). Never request notification permission except from the explicit Enable button. A 2xx from the push service is not proof of display.
- PWA (see docs/PWA.md): `src/app/manifest.ts`, `public/sw.js` (bump `VERSION` on policy/precache changes), `public/offline.html`, `src/lib/pwa.ts`. The service worker must **never cache authenticated HTML or `/bff`/`/session` responses**. New public files that must load signed-out (icons, manifest, SW) need excluding in the `middleware.ts` matcher. Keep `htmlLimitedBots: /.*/` in `next.config.ts` (otherwise metadata streams into `<body>` and iOS/Chrome ignore the manifest + apple tags). Regenerate icons with `node scripts/generate-icons.mjs` in apps/web.
- Mobile UI: phones (< lg) get the top app bar + bottom tab bar + "More" sheet in `components/app-shell.tsx`, desktop keeps the sidebar. Use `min-h-11`/16px inputs for touch, card lists instead of tables below `md`, `env(safe-area-inset-*)` for fixed bars, and check 390 px width in EN and AR (no horizontal overflow).
- Production requires HTTPS (CDK errors without a certificate/domain). Do not weaken that: phones need HTTPS for the service worker, install and push.
- Web → API calls must forward the client IP with `clientIpHeaders(req)` (apps/web/src/lib/client-ip.ts); otherwise per-IP throttling lumps all users together.
- Do not claim production readiness until docs/REAL_DEVICE_TESTS.md is completed on physical devices.
- Browser E2E: `pnpm --filter @dailytasks/web test:e2e` (Playwright with installed Chrome) against the running compose stack.
- Tests: API integration tests in `apps/api/test/*.e2e-spec.ts` (real Postgres, fake S3); worker tests in `apps/worker/test`.

## AWS
Do not run `cdk deploy`, `push-images.sh`, or create any AWS resources unless the human explicitly approves. See docs/DEPLOYMENT.md.
