# Testing

| Suite | Location | Runner | Needs |
|---|---|---|---|
| Validation unit tests | `packages/validation/src/*.test.ts` | vitest | — |
| API unit tests | `apps/api/src/**/*.spec.ts` | jest | — |
| API integration / authorization tests | `apps/api/test/*.e2e-spec.ts` | jest + supertest | compose Postgres (`dailytasks_test`, recreated per run) |
| Worker tests (fan-out, scheduling, outbox) | `apps/worker/test` | vitest | compose Postgres |
| Web unit/component tests (incl. PWA platform detection, locale resolution) | `apps/web/src/**/*.test.ts(x)` | vitest + Testing Library | — |
| Infrastructure assertions | `infrastructure/aws-cdk/test` | vitest + CDK assertions | — |
| Docker end-to-end smoke test | `scripts/docker-smoke-test.mjs` | node | running compose stack |

```bash
docker compose up -d postgres localstack
pnpm build:packages
pnpm test             # all suites (sequential)
docker compose up -d --build && pnpm test:docker
```
Test setup refuses to reset any database whose name does not end in `_test`.

## Critical scenarios → tests

| # | Scenario | Test |
|---|---|---|
| 1 | Employee cannot see another employee's tasks | api `authorization › 1.` |
| 2 | Employee cannot access another project | api `authorization › 2.` |
| 3 | Manager cannot access an unauthorized project | api `authorization › 3.` |
| 4 | Employee cannot rate themselves | api `ratings › 4/5.` (+ service guard `assigneeId === user.id`) |
| 5 | Employee cannot access any rating endpoint or private feedback | api `ratings › 4/5.` (also checks task detail, lists, history, dashboard) |
| 6 | Manager cannot rate tasks from unauthorized projects | api `ratings › 6.` |
| 7 | Only completed tasks can be rated | api `ratings › 7.` |
| 8 | One rating per task (concurrent writes; DB unique) + audit | api `ratings › 8.` |
| 9 | Empty completion comments rejected | api `task lifecycle › 9.`, validation tests, smoke test |
| 10 | Invalid file types rejected | api `attachments › 10.`, validation + web tests, smoke test |
| 11 | Duplicate notification events don't duplicate records | worker `11.` |
| 12 | Deadline changes invalidate old schedules | api `12.` (version bump + sync) and worker `12.` (stale events ignored) |
| 13 | Completed tasks are not marked overdue | worker `13.` |
| 14 | Rating averages calculated correctly | api `ratings › 14.` (incl. unrated/reopened exclusion) |
| 15 | Removing a membership prevents future access | api `authorization › 15.` |

The Docker smoke test additionally proves the real pipeline: outbox → SQS (LocalStack) → worker → notifications, S3 pre-signed upload/download, web BFF cookie login and CSRF rejection, and a real overdue alert fired by the local scheduler.
