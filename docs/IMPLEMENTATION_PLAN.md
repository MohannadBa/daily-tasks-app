# Implementation plan & status

Legend: ✅ done and verified · ⏳ not started · ⚠️ partial

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Monorepo (pnpm), Docker Compose, Prisma schema + migration + seed, auth (local JWT + Cognito) | ✅ | `docker compose up --build` healthy; migration with CHECK constraints |
| 2 | Users, projects, memberships, central authorization | ✅ | api tests 1–3, 15 |
| 3 | Tasks, deadlines, comments, attachments (pre-signed S3), completion, reopen, reassignment, history | ✅ | api lifecycle + attachment tests; smoke test S3 upload/download |
| 4 | Ratings, private feedback, audit, performance averages | ✅ | api tests 4–8, 14 |
| 5 | Next.js manager portal (all listed screens), English/Arabic + RTL | ✅ | `next build`, web tests, manual browser check desktop + 375 px, LTR + RTL |
| 6 | Expo mobile app + OS push | ⏳ | Package placeholder only (`apps/mobile`); push backend (Expo) ready |
| 7 | Worker: outbox, SQS, notifications, Expo push + receipts, deadline scheduling (local + EventBridge), retries/DLQ | ✅ | worker tests 11–13; smoke test incl. real overdue alert |
| 8 | AWS CDK (staging/production), deployment docs, security, E2E | ✅ (not deployed) | `cdk synth`, 7 CDK assertion tests, smoke test |

## Package versions (pinned ranges)
Node 22 LTS (images), TypeScript 5.9, NestJS 11, Prisma 6.19, PostgreSQL 16, Next.js 15.5 / React 19.1, Tailwind 4, TanStack Query 5, zod 3.25, AWS SDK v3, aws-cdk-lib 2.x, LocalStack 3.8.1, Expo SDK 54 (planned for mobile).

## Decisions
* **Expo Push** over direct FCM: one API for APNs + FCM, token management and receipts; least code to maintain.
* **API-proxied Cognito login** (`USER_PASSWORD_AUTH`) so web and mobile share one login contract; web keeps tokens in httpOnly cookies via the BFF.
* **LocalStack 3.8.1** (S3 + SQS) for local AWS; deadline scheduling uses a Postgres-backed scheduler locally because EventBridge Scheduler does not fire in LocalStack.
* **Added `packages/database`** (not in the original layout) so API and worker share one Prisma schema and event contracts.
* Compose Postgres is published on host port **5433** to avoid clashing with a locally installed PostgreSQL.

## Remaining work
1. **Mobile app (Phase 6):** Expo Router screens (employee + manager), SecureStore token storage + refresh, `expo-notifications` registration (`POST /devices`), Android channel `tasks`, deep links `dailytasks://tasks/<id>`, image/document pickers using `uploadAttachment` from `@dailytasks/api-client`, Arabic/RTL, jest-expo tests. Restore the real scripts from `scriptsWhenImplemented` in `apps/mobile/package.json`.
2. Browser E2E (Playwright) for the portal (API-level E2E exists).
3. Cleanup job for abandoned `PENDING` attachments / orphaned S3 objects.
4. Paginated scopes for very large "awaiting rating" sets (currently an id `IN` list).
5. CI pipeline (lint → typecheck → test → build images → synth) and first AWS deployment (requires approval, account, domain/ACM, alarm e-mail).
