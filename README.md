# Al-Rasiyat · الراسيات — Task Management

Arabic-first task management platform for Al-Rasiyat (repository/package name: `dailytasks`). Admins manage departments and accounts; project managers assign tasks by department and priority; employees work, transfer, request extensions and submit completion from their phone; only an approval completes a task. Accountable time is tracked by a server-side ledger (manager review pauses the clock; rejected review time is charged). Projects have a Documents Center fed automatically by approved deliverables, everyone has a private personal-task workspace, PDF reports are rendered in Arabic or English, and managers privately rate completed work.

There is **no native mobile app**: one responsive Next.js web app serves desktop and phones, and installs to the iPhone/Android Home Screen as a PWA (see [docs/PWA.md](docs/PWA.md)).

| Part | Tech | Status |
|---|---|---|
| API | NestJS 11, Prisma 6, PostgreSQL 16, Swagger | ✅ |
| Worker | Node 22, SQS, EventBridge Scheduler, Web Push (VAPID) | ✅ |
| Web app (desktop + phones, installable PWA) | Next.js 15, Tailwind 4, React Query, Arabic-first (RTL) + English, Al-Rasiyat design system, manifest + service worker | ✅ |
| Real-time updates | WebSocket on the API, Postgres LISTEN/NOTIFY fan-out | ✅ |
| Push notifications | Web Push to installed PWA (iOS 16.4+, Android) and desktop browsers | ✅ (real-device checklist pending) |
| Infrastructure | Docker Compose (local), AWS CDK (ECS Fargate, ALB + HTTPS, Route 53/ACM, RDS, S3, SQS, Scheduler, Cognito, CloudWatch, Secrets Manager) | ✅ synth-verified, not deployed |

> **Not production-ready yet:** real-device push testing on a physical iPhone and Android phone (docs/REAL_DEVICE_TESTS.md) has not been done.

## Quick start (Docker)

Requirements: Docker Desktop, Node ≥ 22.12, pnpm 10 (`npm i -g pnpm@10`).

```bash
docker compose up --build        # first run: builds images, migrates, seeds demo data
```

| Service | URL |
|---|---|
| Web app (all roles; installable) | http://localhost:3001 |
| API | http://localhost:3000/api/v1 |
| Swagger | http://localhost:3000/api/docs |
| Health | http://localhost:3000/health |
| Postgres | localhost:5433 (user/pass `dailytasks`) |
| LocalStack (S3 + SQS) | http://localhost:4566 |

Other commands: `docker compose up -d`, `docker compose ps`, `docker compose logs -f`, `docker compose down` (data volumes are kept; `down -v` deletes them).

### Demo accounts (local seed only)
Password for all: `Password123!`

| Role | Email |
|---|---|
| Company admin | admin@dailytasks.local |
| Project manager (Mona) | manager1@dailytasks.local |
| Project manager (Khalid) | manager2@dailytasks.local |
| Employee (Omar, Arabic) | employee1@dailytasks.local |
| Employees | employee2…employee4@dailytasks.local |

## Development

```bash
pnpm install
pnpm build:packages
docker compose up -d postgres localstack     # infrastructure only
pnpm dev:api        # http://localhost:3000  (needs apps/api env, see .env.example)
pnpm dev:worker
pnpm dev:web        # http://localhost:3001
```

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test            # unit + integration (requires the compose Postgres)
pnpm test:docker     # API-level end-to-end against the running compose stack
pnpm --filter @dailytasks/web test:e2e   # browser end-to-end (Playwright, installed Chrome) against the compose stack
pnpm cdk:synth       # synthesize AWS CloudFormation (no deployment)
```

## Documentation
- [Production plan](docs/PRODUCTION_PLAN.md) — production-first release in restricted acceptance mode (nothing deployed yet)
- [Staging plan](docs/STAGING_PLAN.md) — superseded (staging skipped)
- [Operations](docs/OPERATIONS.md) — backups, rollback, migrations, alarms, incident response, key rotation
- [Cognito tests](docs/COGNITO_TESTS.md) — local/contract evidence vs. real staging verification (not run yet)
- [Visual QA](docs/VISUAL_QA.md) — screens and PDFs reviewed, issues fixed
- [User guide](docs/USER_GUIDE.md) — what admins, managers and employees can do, screen by screen
- [Time accounting & workflow](docs/TIME_ACCOUNTING.md) — approval, transfers, extensions, accountable time
- [Enterprise API](docs/API_ENTERPRISE.md) — departments, workflow, documents, personal tasks, reports, accounts
- [Architecture](docs/ARCHITECTURE.md) — components, flows, security model
- [Database](docs/DATABASE.md) — schema design and constraints
- [Testing](docs/TESTING.md) — test strategy and the critical scenarios
- [Design system](docs/DESIGN_SYSTEM.md) — brand colours from the logo, tokens, components
- [PWA](docs/PWA.md) — installing on iPhone/Android, service worker, offline, mobile UI
- [Push notifications](docs/PUSH_NOTIFICATIONS.md) — Web Push architecture, API, config, real-device checklist
- [Deployment](docs/DEPLOYMENT.md) — AWS architecture, HTTPS/domain, environment variables, setup, cost estimate
- [Security audit](docs/SECURITY_AUDIT.md) — production-readiness review and fixes
- [Real-device tests](docs/REAL_DEVICE_TESTS.md) — iPhone/Android test record (**not yet executed**)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — phases, status, remaining work
