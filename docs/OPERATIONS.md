# Operations runbook

Applies to the AWS environments defined in `infrastructure/aws-cdk` (none deployed yet). Values marked
"staging / production" come from `lib/config.ts`.

## 1. Database backup & recovery (RDS PostgreSQL 16)
| | Staging | Production |
|---|---|---|
| Automated backups + point-in-time recovery (PITR) | 3 days | 14 days |
| Multi-AZ (synchronous standby) | no | yes |
| Deletion protection / stack removal | off / **deleted, no final snapshot** | on / final snapshot; credentials secret retained |
| Backup window / maintenance | 23:00–00:00 UTC / Fri 00:00–01:00 UTC | same (02:00–03:00 / Fri 03:00 Riyadh) |
| Manual snapshot | — | automatically before every `deploy-production.sh migrate`; on demand with `snapshot` |
| Encryption at rest | KMS (AWS managed) | KMS (AWS managed `aws/rds`, eu-north-1) |
| Cross-region automated backups | — | **eu-west-1 (Ireland)**, 14 days, customer-managed key `alias/dailytasks-production-backups` (DailyTasks-DR stack) |
| Automated backups when the instance is deleted | deleted | **kept** (`DeleteAutomatedBackups=false`), expire only by retention |

**Restore procedure (PITR or snapshot):**
1. Declare an incident; stop writers: scale `api` and `worker` services to 0 (`aws ecs update-service --desired-count 0`).
2. `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <db> --target-db-instance-identifier <db>-restore --restore-time <UTC>` (or `restore-db-instance-from-db-snapshot`). Same VPC subnet group and security group.
3. Point the application at the restored instance: update the RDS secret's `host` (Secrets Manager) or rename instances (rename old → `-old`, restored → original identifier).
4. Run the migrate task (idempotent; applies anything missing and verifies the time ledger).
5. Scale services back up; verify `/health`, a login, a task list; keep the old instance until confirmed, then delete.
* **Personal tasks need the encryption key that was current at backup time** — see §8. A restore is useless for personal tasks without it.
* Files live in S3 (not in the database). Production versions objects (90-day non-current retention); staging does not. Reports are disposable (re-generate).
* **Restore drill (production launch blocker, then quarterly):** `scripts/deploy-production.sh restore-drill` restores the latest restorable time to a temporary instance `dailytasks-production-drill-*` in the same subnets/security group/parameter group, runs the read-only `verify-restore` (migration history, table counts, **every personal task decrypts with the current key**) through the API task definition with `DB_HOST_OVERRIDE`, prints the restore duration, and offers to delete the instance. Target guard: the verifier only starts when the endpoint is the drill instance's own and not production's, and the verifier itself refuses unless its connection points at the expected drill host (`VERIFY_RESTORE_EXPECT_HOST`); deletion is limited to `dailytasks-production-drill-*`. `DB_HOST_OVERRIDE` only accepts `*.rds.amazonaws.com` and still verifies the certificate.

## 1b. Cross-region backups (eu-north-1 → eu-west-1)
**What is replicated.** RDS *automated backups* (daily snapshots + transaction logs) of the production instance are replicated by RDS itself to eu-west-1, re-encrypted with the customer-managed key in the `DailyTasks-DR` stack, and kept for **14 days** (same as the source). Point-in-time restore is possible in Ireland within that window. Every **manual** snapshot taken by `deploy-production.sh` (`snapshot`, and automatically before `migrate`) is also copied to eu-west-1 under the same key; manual snapshots and their copies are never deleted automatically.
**Not replicated (gaps for a full regional disaster):** S3 files (attachments/documents — no S3 cross-region replication yet), Cognito users, Secrets Manager secrets, ECR images. See "Regional disaster" below.

**Replication delays (measure and record during the DR drill).** The first replication after enabling copies a full snapshot: proportional to the data size (minutes for a few GB, can be hours for large databases). Afterwards transaction logs are shipped continuously and daily snapshots after the backup window; the *latest restorable time* in Ireland normally trails the source by minutes. `scripts/deploy-production.sh check` prints the Ireland status, latest restorable time and retention. Effective **regional RPO = that lag** (in-region RPO stays ≈ 5 min).

**Encryption & KMS.** Source: `aws/rds` (AWS-managed, eu-north-1). Destination: customer-managed key in eu-west-1 — rotation yearly, RETAINED, key policy allows RDS use only via `rds.eu-west-1.amazonaws.com` for this account, and **denies `kms:DisableKey` and `kms:ScheduleKeyDeletion` to everyone** (deleting/disabling it would destroy every Ireland backup; a human must edit the key policy first). The identity enabling replication (the CDK CloudFormation execution role) needs `kms:CreateGrant`/`kms:DescribeKey` on that key — granted through the account-root statement of the key policy. Verified offline only (template + tests); the first `deploy` proves it on AWS (CloudFormation fails if the grant is refused).

**Teardown.** No automatic deletion of backups: the production instance has deletion protection, snapshot-on-delete and `DeleteAutomatedBackups=false`; replicated automated backups remain in Ireland until their 14-day retention expires; manual snapshots and Ireland copies stay until a human deletes them; the DR stack has termination protection and the key/subnet group are retained.

**Restore in Ireland — drill (safe, quarterly and before launch):** `scripts/deploy-production.sh dr-drill` → finds the replicated automated backup, restores the latest restorable time into the isolated drill network (no internet route, security group with no inbound/outbound rules), checks the instance is `available`, encrypted, and uses the Ireland key, prints restore minutes and the latest restorable time, and deletes **only** the drill instance (`dailytasks-production-drdrill-*`). It cannot touch production: source backups are read-only for a restore, the drill has its own identifier in another region, and the delete is guarded by the identifier prefix. Data-level checks (decrypting personal tasks) are covered by the in-region `restore-drill` of the same backup stream; the isolated Ireland copy is deliberately unreachable.

**Restore in Ireland — real recovery (manual, as part of a regional disaster):**
```bash
aws rds describe-db-instance-automated-backups --region eu-west-1 --db-instance-identifier <prod DB id>   --query 'DBInstanceAutomatedBackups[0].[DBInstanceAutomatedBackupsArn,RestoreWindow.LatestTime]'
aws rds restore-db-instance-to-point-in-time --region eu-west-1 --source-db-instance-automated-backups-arn <arn>   --target-db-instance-identifier dailytasks-production-dr --use-latest-restorable-time (or --restore-time <UTC>)   --db-subnet-group-name <subnet group of the recovery stack> --vpc-security-group-ids <its DB security group>   --db-instance-class db.t4g.medium --multi-az --db-parameter-group-name <its parameter group> --deletion-protection
```
**Regional disaster (eu-north-1 unavailable) — outline, RTO estimate 4–8 h, never exercised end to end:**
1. Declare the incident; freeze changes; decide the restore point (latest restorable time in Ireland).
2. eu-west-1 is already bootstrapped. Deploy `DailyTasks-Registry` there and push the release images from a PC (`AWS_REGION=eu-west-1 scripts/push-images.sh <tag>`).
3. Recreate secrets in eu-west-1: personal-data key **from escrow** (mandatory — otherwise personal tasks are unreadable), new VAPID keys (users re-enable notifications).
4. Deploy the application stack to eu-west-1 (a recovery configuration with `region=eu-west-1`; SES identity re-verified there; Cognito pool is new).
5. Restore the database as above into the recovery stack's subnet group/security group; point the stack's DB secret `host` at it; run `migrate` (applies nothing, verifies the ledger).
6. Users: the Cognito pool in eu-north-1 is unavailable; accounts must be re-provisioned/reset in the new pool (procedure to be designed and rehearsed before relying on it).
7. Repoint DNS (Route 53 is global) to the new ALB; files uploaded before the disaster are unavailable until eu-north-1 returns (no S3 replication).
Recommended follow-ups: S3 cross-region replication to eu-west-1, Secrets Manager replica of the personal-data key in eu-west-1, a rehearsed Cognito re-provisioning procedure.

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
E-mail delivery requires `ALARM_EMAIL` (optional during restricted acceptance; set/change it as in PRODUCTION_PLAN.md §14). Without it, alarms are visible in the CloudWatch console only. In the CloudFront layout (no custom domain) the WAF alarm and WAF logs live in **us-east-1** (`DailyTasks-Edge`).
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
| Api/WebUnhealthyHostsAlarm | ≥ 1 target failing ALB health checks for 3 min | Service events, container logs; recent deploy? |
| DbMemoryAlarm | RDS freeable memory < 256 MB | Query load, connection count; consider a larger class |
| DbConnectionsAlarm | > 300 connections (prod) / 60 (staging) | Connection leak or runaway scaling |
| WafSignInBlocksAlarm (prod) | > 50 sign-in requests blocked in 5 min | Password guessing (check WAF logs) — or an office NAT needs `WAF_AUTH_RATE_LIMIT` raised |
Not alarmed (recommended additions): Cognito throttling, report render failures as a separate metric, AWS Budget alert ($500 production).

## 5. Logs
* Structured JSON logs (API in production), one log group per service, **retention 14 days (staging) / 90 days (production)**; production log groups are RETAINED if the stack is ever deleted. RDS PostgreSQL logs exported to CloudWatch.
* Production also keeps: ALB access logs (private S3 bucket, 90 days) and WAF logs (`aws-waf-logs-dailytasks-production`, 90 days, `Authorization`/`Cookie` headers redacted).
* Logs never contain passwords, tokens, push subscription keys, encryption keys or personal-task content (reviewed; push endpoints logged by host only).
* Retention beyond 90 days (compliance) → export to S3 with lifecycle rules (not configured).

## 6. Incident response
1. **Detect** (alarm e-mail, user report) → acknowledge in the ops channel; assign an incident lead.
2. **Assess** severity: S1 = outage/data exposure, S2 = major feature broken, S3 = degraded.
3. **Contain:** roll back the release (§2); for suspected account compromise: Administration → Deactivate (disables the Cognito user + global sign-out) or Reset password (also signs out everywhere); for suspected credential leak → rotate the affected secret (§7).
4. **Eradicate & recover:** fix, redeploy, restore data if needed (§1).
5. **Post-incident review** within 5 working days: timeline, root cause, actions. Personal-data incidents: follow the company's data-protection notification obligations.
Evidence sources: CloudWatch logs, `AuditLog` table (accounts, departments, documents), `TaskHistory`, ALB access logs and WAF logs (production), CloudTrail (account-level, enable if not already).
Emergency lock-down: redeploy with `ACCESS_MODE=restricted` and an admin-only allow-list (every other account is refused on its next request), and/or set `ALLOWED_CIDRS` to the office range.

## 7. Secret rotation
| Secret | Where | Rotation |
|---|---|---|
| RDS master credentials | Secrets Manager (generated by RDS) | Enable Secrets Manager rotation (single-user) — not configured yet; after rotating, restart api/worker (`force-new-deployment`) |
| VAPID private key | Secrets Manager `dailytasks-production/vapid-private-key` (worker only) | Rotate only if leaked: new key pair → update secret + `vapidPublicKey` context → redeploy. **All existing push subscriptions become invalid**; users re-enable notifications (in-app history unaffected) |
| Personal-data key | Secrets Manager (api only, RETAIN) | §8 |
| Cognito | managed by AWS | n/a (users rotate passwords; admins can force resets) |
| `JWT_SECRET` | local auth mode only | not used in AWS |

## 8. Personal-data encryption key — backup, recovery, rotation
**Backup (do this right after the first deploy):** read the generated value once (`aws secretsmanager get-secret-value --secret-id dailytasks-<env>/personal-data-key`) and store it in the company's offline escrow (e.g. a password manager vault with two custodians, or a sealed printout in a safe). Without it, personal tasks in the database **and in every backup** are unrecoverable. The secret is `RETAIN` (survives stack deletion); consider cross-region secret replication for production.
**Recovery:** if the secret is lost but escrowed, put the escrowed value back into the secret and force a new deployment of the api service.
**Rotation (planned, no downtime):**
1. Create a secret with the *current* value: `dailytasks-<env>/personal-data-key-previous`.
2. Put a new random value (≥ 32 chars) into `dailytasks-<env>/personal-data-key`; escrow it (keep the old escrow copy too).
3. Deploy with `-c <env>:personalDataKeyPreviousSecretArn=<arn of step 1>` → the API decrypts old rows with the previous key and re-encrypts them when read.
4. Re-encrypt everything: run the api task definition (`ApiTaskDefinition` output) with command `["node","/app/packages/database/dist/rekey-personal.js"]` → prints `scanned / re-encrypted / undecryptable` counts (exit 1 if any row is undecryptable — investigate before step 5).
5. Deploy again without `personalDataKeyPreviousSecretArn`; delete the previous-key secret after the backup retention period has passed (older backups still need the old key — keep its escrow copy until then).
Tested: cipher fallback + re-key (`packages/database/test/personal-cipher.test.ts`), lazy re-encryption through the API (`apps/api/test/enterprise.e2e-spec.ts`).

## 9. Routine tasks
* First admin of a new environment: `bootstrap-admin` one-off task (see [STAGING_PLAN.md](STAGING_PLAN.md) §5.7) — refuses if an admin exists.
* Expired reports and abandoned uploads are deleted by the worker (hourly); report objects also expire via S3 lifecycle (8 days).
* Review `AuditLog` for account changes monthly; review CloudWatch alarm history weekly.
