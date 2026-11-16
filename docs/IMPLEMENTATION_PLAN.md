# Implementation plan & status

Legend: ✅ done and verified · ⏳ not started · ⚠️ partial

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Monorepo (pnpm), Docker Compose, Prisma schema + migration + seed, auth (local JWT + Cognito) | ✅ | `docker compose up --build` healthy; migration with CHECK constraints |
| 2 | Users, projects, memberships, central authorization | ✅ | api tests 1–3, 15 |
| 3 | Tasks, deadlines, comments, attachments (pre-signed S3), completion, reopen, reassignment, history | ✅ | api lifecycle + attachment tests; smoke test S3 upload/download |
| 4 | Ratings, private feedback, audit, performance averages | ✅ | api tests 4–8, 14 |
| 5 | Next.js web app (all listed screens), English/Arabic + RTL | ✅ | `next build`, web tests, manual browser check desktop + 375 px, LTR + RTL |
| 6 | ~~Expo mobile app~~ → **installable PWA**: manifest, service worker, icons, iOS metadata, offline shell, install guide, deep links, mobile navigation (bottom tabs) and touch-optimised screens | ✅ | web tests (`pwa`, `locale`), Chrome installability check (0 errors), SW offline deep-link check, 390 px overflow check EN+AR; see docs/PWA.md |
| 6b | Web Push notifications (VAPID): PushSubscription/PushDelivery, `/push/*` API, service-worker push/click, settings page, retries/expiry, CDK secret + alarm | ✅ (real devices pending) | worker push tests (real encryption + VAPID), API push e2e, SW sandbox tests, Docker smoke test with fake push service, desktop Chrome + real FCM delivery; see docs/PUSH_NOTIFICATIONS.md |
| 7 | Worker: outbox, SQS, notifications, push delivery, deadline scheduling (local + EventBridge), retries/DLQ | ✅ | worker tests 11–13; smoke test incl. real overdue alert |
| 8 | AWS CDK (staging/production), deployment docs, security, E2E | ✅ (not deployed) | `cdk synth`, 7 CDK assertion tests, smoke test |

## Package versions (pinned ranges)
Node 22 LTS (images), TypeScript 5.9, NestJS 11, Prisma 6.19, PostgreSQL 16, Next.js 15.5 / React 19.1, Tailwind 4, TanStack Query 5, zod 3.25, AWS SDK v3, aws-cdk-lib 2.x, LocalStack 3.8.1.

## Decisions
* **PWA instead of a native app** (changed requirement): one responsive Next.js codebase for desktop, phone browsers and Home Screen installs. The empty `apps/mobile` Expo placeholder was removed; no shared code depended on it.
* **Web Push** replaced Expo Push (the native app was dropped): standard VAPID Web Push via the `web-push` library for encryption/JWT, requests sent with `fetch`; per-device `PushDelivery` rows make retries idempotent; endpoint host allow-list prevents SSRF.
* **API-proxied Cognito login** (`USER_PASSWORD_AUTH`) so every client shares one login contract; the web app keeps tokens in httpOnly cookies via the BFF.
* **LocalStack 3.8.1** (S3 + SQS) for local AWS; deadline scheduling uses a Postgres-backed scheduler locally because EventBridge Scheduler does not fire in LocalStack.
* **Added `packages/database`** (not in the original layout) so API and worker share one Prisma schema and event contracts.
* Compose Postgres is published on host port **5433** to avoid clashing with a locally installed PostgreSQL.

## Remaining work
1. **Real-device push acceptance (blocker)** on a physical iPhone (iOS 16.4+) and Android phone against HTTPS staging with real VAPID keys — record in docs/REAL_DEVICE_TESTS.md.
1a. Production readiness audit done 2026-11-16 (docs/SECURITY_AUDIT.md): HTTPS enforced, custom domain automation, per-client throttling fix, HSTS, worker tini. Recommended next: CSP, WAF, ALB access logs, RDS `verify-full`.
2. Browser E2E (Playwright) for the web app incl. mobile viewports (API-level E2E exists).
3. Cleanup job for abandoned `PENDING` attachments / orphaned S3 objects.
4. Paginated scopes for very large "awaiting rating" sets (currently an id `IN` list).
5. CI pipeline (lint → typecheck → test → build images → synth) and first AWS deployment (requires approval, account, domain/ACM, alarm e-mail).
