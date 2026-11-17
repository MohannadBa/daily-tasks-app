# Operations runbook

Applies to the AWS environments defined in `infrastructure/aws-cdk` (none deployed yet). Values marked
"staging / production" come from `lib/config.ts`.

## 1. Database backup & recovery (RDS PostgreSQL 16)
| | Staging | Production |
|---|---|---|
| Automated backups + point-in-time recovery (PITR) | 3 days | 14 days |
| Multi-AZ (synchronous standby) | no | yes |
| Deletion protection / stack removal | off / **deleted, no final snapshot** | on / retained |
| Encryption at rest | KMS (AWS managed) | KMS (AWS managed) |

**Restore procedure (PITR or snapshot):**
1. Declare an incident; stop writers: scale `api` and `worker` services to 0 (`aws ecs update-service --desired-count 0`).
2. `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <db> --target-db-instance-identifier <db>-restore --restore-time <UTC>` (or `restore-db-instance-from-db-snapshot`). Same VPC subnet group and security group.
3. Point the application at the restored instance: update the RDS secret's `host` (Secrets Manager) or rename instances (rename old → `-old`, restored → original identifier).
4. Run the migrate task (idempotent; applies anything missing and verifies the time ledger).
5. Scale services back up; verify `/health`, a login, a task list; keep the old instance until confirmed, then delete.
* **Personal tasks need the encryption key that was current at backup time** — see §8. A restore is useless for personal tasks without it.
* Files live in S3 (not in the database). Production versions objects (90-day non-current retention); staging does not. Reports are disposable (re-generate).
* Recommended before go-live: a **restore drill** on staging, recorded with timings (RTO/RPO).

## 2. Application rollback
* ECS deployments use the circuit breaker: a release whose tasks fail health checks rolls back automatically.
* Manual rollback: `cdk deploy DailyTasks-<env> -c imageTag=<previous immutable tag> …` (same context as the original deploy). Images are immutable in ECR; the last 50 are kept.
* The PWA service worker updates on the next app launch; the API is backward compatible within `/api/v1`.

## 3. Migration rollback — limitations (read before every release)
Prisma migrations are **forward-only**; there are no automatic down-migrations. The enterprise release in particular:
* renames the enum value `COMPANY_ADMIN → ADMIN` and adds enum values (`PENDING_REVIEW`, new history/notification types). PostgreSQL cannot drop enum values; reverting requires recreating the types by hand.
* adds tables, columns, CHECK constraints and triggers, and back-fills data (approver, original deadline, time ledger).
Therefore: **an application rollback across a migration is only safe if the older image tolerates the newer schema.** The previous release (`586e0bb`) does not know `PENDING_REVIEW`/`ADMIN`, so rolling the *code* back past the enterprise release is not supported. The supported path is: restore the pre-release snapshot (§1) together with the previous image.
**Release rule:** take a manual RDS snapshot immediately before running the migrate task of any release that contains migrations; note its identifier in the release record.

## 4. Monitoring & alarms (CloudWatch → SNS e-mail)
| Alarm | Condition | First response |
|---|---|---|
| DbCpuAlarm | RDS CPU > 80 % for 3 periods | Check slow queries (Performance Insights in prod), report/list load |
| DbStorageAlarm | Free storage < 5 GB | Storage autoscaling should grow it (max 50/500 GB); check log/temp growth |
| DlqAlarm | ≥ 1 message in the events dead-letter queue | Inspect the message type; fix; redrive from the DLQ |
| QueueAgeAlarm | Oldest event > 5 min | Worker down/stuck: check worker health + logs; scale worker |
| WorkerErrorsAlarm | ≥ 10 worker error log lines (outbox/processing) | Logs Insights on `/dailytasks/<env>/worker` |
| PushFailuresAlarm | ≥ 25 failed push deliveries | VAPID config, push service status (FCM/APNs/Mozilla) |
| Alb5xxAlarm | ≥ 20 target 5xx responses | API/web logs; recent deploy? roll back |
| Api/Web/Worker CpuAlarm | CPU > 85 % for 3 periods | Autoscaling (prod) — check for runaway requests |
Not alarmed (recommended additions): ALB unhealthy hosts, Cognito throttling, RDS connection count, report render failures as a separate metric, AWS Budget alert.

## 5. Logs
* Structured JSON logs (API in production), one log group per service, **retention 14 days (staging) / 90 days (production)**. RDS PostgreSQL logs exported to CloudWatch.
* Logs never contain passwords, tokens, push subscription keys, encryption keys or personal-task content (reviewed; push endpoints logged by host only).
* Retention beyond 90 days (compliance) → export to S3 with lifecycle rules (not configured).

## 6. Incident response
1. **Detect** (alarm e-mail, user report) → acknowledge in the ops channel; assign an incident lead.
2. **Assess** severity: S1 = outage/data exposure, S2 = major feature broken, S3 = degraded.
3. **Contain:** roll back the release (§2); for suspected account compromise: Administration → Deactivate (disables the Cognito user + global sign-out) or Reset password (also signs out everywhere); for suspected credential leak → rotate the affected secret (§7).
4. **Eradicate & recover:** fix, redeploy, restore data if needed (§1).
5. **Post-incident review** within 5 working days: timeline, root cause, actions. Personal-data incidents: follow the company's data-protection notification obligations.
Evidence sources: CloudWatch logs, `AuditLog` table (accounts, departments, documents), `TaskHistory`, ALB access logs (not enabled — recommended for production), CloudTrail (account-level, enable if not already).

## 7. Secret rotation
| Secret | Where | Rotation |
|---|---|---|
| RDS master credentials | Secrets Manager (generated by RDS) | Enable Secrets Manager rotation (single-user) — not configured yet; after rotating, restart api/worker (`force-new-deployment`) |
| VAPID private key | Secrets Manager (worker only) | Rotate only if leaked: new key pair → update secret + `vapidPublicKey` context → redeploy. **All existing push subscriptions become invalid**; users re-enable notifications (in-app history unaffected) |
| Personal-data key | Secrets Manager (api only, RETAIN) | §8 |
| Cognito | managed by AWS | n/a (users rotate passwords; admins can force resets) |
| `JWT_SECRET` | local auth mode only | not used in AWS |

## 8. Personal-data encryption key — backup, recovery, rotation
**Backup (do this right after the first deploy):** read the generated value once (`aws secretsmanager get-secret-value --secret-id dailytasks/<env>/personal-data-key`) and store it in the company's offline escrow (e.g. a password manager vault with two custodians, or a sealed printout in a safe). Without it, personal tasks in the database **and in every backup** are unrecoverable. The secret is `RETAIN` (survives stack deletion); consider cross-region secret replication for production.
**Recovery:** if the secret is lost but escrowed, put the escrowed value back into the secret and force a new deployment of the api service.
**Rotation (planned, no downtime):**
1. Create a secret with the *current* value: `dailytasks/<env>/personal-data-key-previous`.
2. Put a new random value (≥ 32 chars) into `dailytasks/<env>/personal-data-key`; escrow it (keep the old escrow copy too).
3. Deploy with `-c <env>:personalDataKeyPreviousSecretArn=<arn of step 1>` → the API decrypts old rows with the previous key and re-encrypts them when read.
4. Re-encrypt everything: run the api task definition (`ApiTaskDefinition` output) with command `["node","/app/packages/database/dist/rekey-personal.js"]` → prints `scanned / re-encrypted / undecryptable` counts (exit 1 if any row is undecryptable — investigate before step 5).
5. Deploy again without `personalDataKeyPreviousSecretArn`; delete the previous-key secret after the backup retention period has passed (older backups still need the old key — keep its escrow copy until then).
Tested: cipher fallback + re-key (`packages/database/test/personal-cipher.test.ts`), lazy re-encryption through the API (`apps/api/test/enterprise.e2e-spec.ts`).

## 9. Routine tasks
* First admin of a new environment: `bootstrap-admin` one-off task (see [STAGING_PLAN.md](STAGING_PLAN.md) §5.7) — refuses if an admin exists.
* Expired reports and abandoned uploads are deleted by the worker (hourly); report objects also expire via S3 lifecycle (8 days).
* Review `AuditLog` for account changes monthly; review CloudWatch alarm history weekly.
