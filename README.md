# DailyTasks

Task management for one company: admins create projects and invite people, project managers assign tasks with deadlines and files, employees reply and complete tasks from their phone, and managers privately rate completed work.

There is **no native mobile app**: one responsive Next.js web app serves desktop and phones, and installs to the iPhone/Android Home Screen as a PWA (see [docs/PWA.md](docs/PWA.md)).

| Part | Tech | Status |
|---|---|---|
| API | NestJS 11, Prisma 6, PostgreSQL 16, Swagger | ✅ |
| Worker | Node 22, SQS, EventBridge Scheduler, Expo Push | ✅ |
| Web app (desktop + phones, installable PWA) | Next.js 15, Tailwind 4, React Query, English/Arabic (RTL), manifest + service worker | ✅ |
| Push notifications | Expo Push today → Web Push migration pending | ⚠️ |
| Infrastructure | Docker Compose (local), AWS CDK (ECS Fargate, RDS, S3, SQS, Cognito, CloudWatch) | ✅ synth-verified, not deployed |

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
pnpm test:docker     # end-to-end against the running compose stack
pnpm cdk:synth       # synthesize AWS CloudFormation (no deployment)
```

## Documentation
- [Architecture](docs/ARCHITECTURE.md) — components, flows, security model
- [Database](docs/DATABASE.md) — schema design and constraints
- [Testing](docs/TESTING.md) — test strategy and the critical scenarios
- [PWA](docs/PWA.md) — installing on iPhone/Android, service worker, offline, mobile UI
- [Deployment](docs/DEPLOYMENT.md) — AWS setup, staging/production, migrations
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) — phases, status, remaining work
