# Deployment (AWS)

> **Nothing has been deployed.** Every step below creates chargeable AWS resources and must be run deliberately by an operator, with approval. `pnpm cdk:synth` is free and needs no credentials.

## Production architecture

```
 Phones (installed PWA) · desktop browsers
        │ HTTPS  https://tasks.example.com   (Route 53 alias → ALB, ACM certificate, HTTP→HTTPS redirect)
        ▼
 ┌──────────────── Application Load Balancer (public subnets) ────────────────┐
 │  /api/*, /health ──► api service          everything else ──► web service  │
 └───────────────────────────────┬────────────────────────────────────────────┘
                                 │ private subnets (NAT egress)
   web (Next.js standalone: pages, /bff proxy, manifest, /sw.js, icons) ──Cloud Map──► api (NestJS)
   api ──► RDS PostgreSQL 16 (isolated subnets, TLS)   ──► S3 (private; pre-signed URLs) ──► Cognito
   api ──► OutboxEvent (same DB transaction)
   worker ──► outbox relay ─► SQS (+DLQ) ─► consumer ─► notifications + Web Push (VAPID) ─► FCM / Apple / Mozilla / WNS
   worker ──► EventBridge Scheduler (deadline reminders/overdue → SQS)
   CloudWatch logs + alarms → SNS e-mail · Secrets Manager (DB credentials, VAPID private key)
```

* **Next.js hosting:** ECS Fargate `web` service behind the ALB (no CloudFront needed; if a CDN is added later, `/sw.js` must never be cached by it).
* **Web Push:** standard Web Push protocol with VAPID (`web-push` library). **No Firebase project and no APNs certificate are needed**: browsers choose their own push service and the server talks HTTPS to it. Only outbound HTTPS from the worker (NAT) is required.

## Stacks (`infrastructure/aws-cdk`)
| Stack | Contents |
|---|---|
| `DailyTasks-Registry` | ECR repositories `dailytasks/api`, `dailytasks/worker`, `dailytasks/web` (immutable tags, scan on push) |
| `DailyTasks-staging` / `DailyTasks-production` | VPC (public / private-egress / isolated subnets, S3 gateway endpoint), ALB (HTTPS + redirect), optional Route 53 alias + DNS-validated ACM certificate, ECS Fargate services (api, web, worker) + migration task, RDS PostgreSQL 16 (encrypted, private, `rds.force_ssl`), private S3 bucket (TLS-only, CORS = app URL), SQS queue + DLQ, EventBridge Scheduler group + role, Cognito user pool + app client, Secrets Manager (DB credentials; VAPID private key by reference), CloudWatch logs, alarms (DLQ, queue age, ALB 5xx, CPU, DB CPU/storage, worker errors, push failures) → SNS |

Sizing per environment is in `lib/config.ts` (staging: single-AZ `t4g.micro`, 1 NAT, 1 task each; production: Multi-AZ `t4g.medium`, 2 NAT, ≥2 api/web tasks, CPU autoscaling, deletion protection).

**HTTPS is enforced:** synthesizing `DailyTasks-production` fails unless a certificate (or domain + hosted zone) and an `https://` public URL are configured (`pnpm --filter @dailytasks/aws-cdk run synth:production -c production:domainName=…`). Staging without a certificate only warns. It works in desktop browsers, but **PWA install, the service worker and push do not work on phones without HTTPS**, so give staging a certificate before real-device testing.

## Context parameters
| Key | Meaning |
|---|---|
| `imageTag` / `<env>:imageTag` | Immutable image tag to run (required for a real deploy) |
| `<env>:domainName` | App host, e.g. `tasks.example.com` → `publicUrl=https://tasks.example.com` |
| `<env>:hostedZoneId` + `<env>:hostedZoneName` (or global `hostedZoneId`/`hostedZoneName`) | Route 53 zone containing the domain → alias record + DNS-validated certificate created by the stack |
| `<env>:certificateArn` | Use an existing ACM certificate instead (same region as the stack) |
| `<env>:publicUrl` | Override the public URL (CORS, S3 CORS, VAPID subject default) |
| `<env>:vapidPublicKey` | Web Push VAPID public key (`pnpm push:keys`) |
| `<env>:vapidPrivateKeySecretArn` | Secrets Manager secret whose SecretString is the VAPID private key (worker only) |
| `<env>:vapidSubject` | Optional VAPID contact `mailto:`/`https:` (default `mailto:<alarmEmail>`) |
| `alarmEmail` | E-mail subscribed to alarms |
| `account`, `region` | Target account/region (default: current CLI profile, `me-central-1`) |

Domain not in Route 53? Create/import an ACM certificate (DNS validation at your registrar), pass `certificateArn` + `publicUrl=https://tasks.example.com`, and add a CNAME `tasks.example.com → <ALB DNS>` at your DNS provider.

## Environment variables (complete reference)

Set by the CDK stack in AWS, by `docker-compose.yml` locally. **No real secret is committed**; `.env*` files are git-ignored (only `.env.example`).

| Variable | api | worker | web | Source in AWS | Notes |
|---|:-:|:-:|:-:|---|---|
| `NODE_ENV` | ✓ | ✓ | ✓ | stack | `production` enables production guards |
| `LOG_LEVEL` | ✓ | ✓ | | stack | `info` |
| `DATABASE_URL` | ✓ | ✓ | | built at start from `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_NAME` | Secrets Manager (RDS-generated); `sslmode=require` |
| `DB_SSLMODE`, `DB_CONNECTION_LIMIT` | ✓ | ✓ | | optional | defaults `require`, `10` |
| `DB_SSL_CA_FILE` | ✓ | ✓ | | stack = `/app/certs/rds-global-bundle.pem` (baked into the images) | verifies the RDS server certificate + host name (Prisma `sslaccept=strict`); unset = encrypted but unverified TLS |
| `ACCESS_MODE`, `ACCESS_ALLOWLIST` | ✓ | | | stack (`<env>:accessMode`, `<env>:accessAllowlist`); production defaults to `restricted` | launch gate: only allow-listed e-mails can sign in / be provisioned |
| `DB_HOST_OVERRIDE` | ✓ | | | one-off task override only (restore drills) | points at a restored `*.rds.amazonaws.com` instance |
| `PERSONAL_DATA_KEY_PREVIOUS` | ✓ | | | Secrets Manager, **only during a key rotation** (`<env>:personalDataKeyPreviousSecretArn`) | decrypt fallback; see OPERATIONS.md §8 |
| `AWS_REGION` | ✓ | ✓ | | stack | |
| `AWS_ENDPOINT_URL`, `S3_PUBLIC_ENDPOINT`, `S3_FORCE_PATH_STYLE` | ✓ | ✓ | | — | LocalStack only; unset in AWS |
| `S3_BUCKET` | ✓ | ✓ | | stack | |
| `SQS_EVENTS_QUEUE_URL` | ✓ | ✓ | | stack | |
| `PORT` | ✓ | | ✓ | stack | 3000 |
| `CORS_ORIGINS` | ✓ | | | stack = app URL | browsers use the same-origin BFF; CORS only matters for direct API clients |
| `AUTH_MODE` | ✓ | | | `cognito` | `local` is refused in production |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | ✓ | | | stack | |
| `JWT_SECRET`, `JWT_*_TTL_SECONDS` | ✓ | | | — | local auth mode only |
| **`PERSONAL_DATA_KEY`** | ✓ | | | **Secrets Manager** (`<prefix>/personal-data-key`, generated, **RETAIN**) | AES-256-GCM key for personal tasks; API only; production refuses the dev value; never rotate without re-encrypting |
| `REPORTS_ENABLED`, `CHROMIUM_PATH`, `REPORT_RENDER_TIMEOUT_MS` | | ✓ | | image default `/usr/bin/chromium` | PDF rendering in the worker (Debian Chromium in the image; worker ≥ 1 GB memory) |
| `SWAGGER_ENABLED` | ✓ | | | `false` in production | |
| `RUN_MIGRATIONS` | ✓ | | | `false` | migrations run as a one-off task |
| `HEALTH_PORT` | | ✓ | | 3002 | |
| `SCHEDULER_MODE`, `SCHEDULER_GROUP_NAME`, `SCHEDULER_TARGET_QUEUE_ARN`, `SCHEDULER_ROLE_ARN` | | ✓ | | stack (`eventbridge`) | |
| `OUTBOX_POLL_INTERVAL_MS`, `LOCAL_SCHEDULER_POLL_INTERVAL_MS` | | ✓ | | defaults | |
| `PUSH_ENABLED` | | ✓ | | `true` when VAPID is configured | |
| **`WEB_PUSH_VAPID_PUBLIC_KEY`** (alias `VAPID_PUBLIC_KEY`) | ✓ | ✓ | | context `vapidPublicKey` (plain: public by design) | served to browsers by `GET /api/v1/push/vapid-public-key` |
| **`WEB_PUSH_VAPID_PRIVATE_KEY`** (alias `VAPID_PRIVATE_KEY`) | | ✓ | | **Secrets Manager** (`vapidPrivateKeySecretArn`) | worker only; never in DB, API, logs or images |
| **`WEB_PUSH_SUBJECT`** (alias `VAPID_SUBJECT`) | | ✓ | | stack | `mailto:`/`https:` contact |
| `WEB_PUSH_ALLOWED_HOSTS` | ✓ | ✓ | | default | push-service host allow-list (SSRF guard) |
| `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS` | ✓ | ✓ | | — | local fake push service only; refused in production |
| `WEB_PUSH_TIMEOUT_MS`, `WEB_PUSH_CONCURRENCY` | | ✓ | | defaults | 10000 / 10 |
| `API_INTERNAL_URL` | | | ✓ | stack (Cloud Map) | server-side only |
| `REALTIME_PUBLIC_URL` | | | ✓ | **unset** (same origin via ALB) | browser WebSocket URL; compose sets `ws://localhost:3000/api/v1/realtime` |
| `COOKIE_SECURE` | | | ✓ | `true` with HTTPS | |
| **`NEXT_PUBLIC_VAPID_PUBLIC_KEY`** | | | — | **not used (by design)** | The browser fetches the public key at runtime from the API, so one web image runs in every environment and keys rotate without a rebuild. A `NEXT_PUBLIC_*` value would be baked into the JS bundle at build time. |

The `VAPID_*` names are accepted as aliases (the `WEB_PUSH_*` name wins if both are set). Production refuses the development key pair shipped in `docker-compose.yml`.

> **Current plan: [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md)** (production-first release in restricted acceptance mode, `scripts/deploy-production.sh`). The staging procedure is [STAGING_PLAN.md](STAGING_PLAN.md); backups, rollback, alarms, incident response and key rotation are in [OPERATIONS.md](OPERATIONS.md).

## First-time setup
1. `npx cdk bootstrap aws://<account>/<region>` (once per account/region).
2. `pnpm --filter @dailytasks/aws-cdk run deploy:registry`
3. `AWS_ACCOUNT_ID=<id> AWS_REGION=<region> scripts/push-images.sh` → prints the tag.
4. VAPID keys (once per environment; never reuse between environments):
   ```bash
   pnpm push:keys                     # prints public + private key once
   aws secretsmanager create-secret --name dailytasks/<env>/vapid-private-key --secret-string '<privateKey>'
   ```
5. Deploy (staging first):
   ```bash
   pnpm --filter @dailytasks/aws-cdk exec cdk deploy DailyTasks-staging -c imageTag=<tag> -c alarmEmail=ops@example.com \
     -c staging:domainName=staging.tasks.example.com -c hostedZoneId=<id> -c hostedZoneName=example.com \
     -c staging:vapidPublicKey=<publicKey> -c staging:vapidPrivateKeySecretArn=<secretArn>
   ```
6. Run migrations (one-off task; values from stack outputs):
   ```bash
   aws ecs run-task --cluster dailytasks-staging --launch-type FARGATE \
     --task-definition <MigrateTaskDefinition> \
     --network-configuration "awsvpcConfiguration={subnets=[<MigrateSubnets>],securityGroups=[<MigrateSecurityGroup>]}"
   ```
7. Create the first company + admin **without SQL**: run the `bootstrap-admin` one-off task (exact command in [STAGING_PLAN.md](STAGING_PLAN.md) §5.7; it refuses if an admin already exists), then `aws cognito-idp admin-create-user … --desired-delivery-mediums EMAIL`. The admin signs in, chooses a password and creates everyone else from **Administration**. Escrow the personal-data key now ([OPERATIONS.md](OPERATIONS.md) §8).
8. Confirm the SNS alarm subscription e-mail.
9. Run the **real-device checklist** (docs/REAL_DEVICE_TESTS.md) on staging. Only then deploy production the same way with the production context and the **same image tag**.

## Releases
`push-images.sh` → `cdk deploy DailyTasks-<env> -c imageTag=<tag> …` → run the migration task. ECS deployment circuit breakers roll back failed releases. Promote the same tag from staging to production. The service worker updates itself on the users' next app launch (`/sw.js` is served `no-cache`).

## HTTPS / PWA / push checklist after a deploy
| Check | How |
|---|---|
| HTTP redirects to HTTPS | `curl -I http://<domain>` → 301 to https |
| HSTS | `curl -sI https://<domain>/login \| grep -i strict-transport` |
| Manifest | `curl -s https://<domain>/manifest.webmanifest` → JSON, `start_url` `/`, `display` `standalone` |
| Service worker scope | `curl -sI https://<domain>/sw.js` → `Cache-Control: no-cache, no-store…`, `Service-Worker-Allowed: /` |
| Icons | `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/maskable-512.png`, `/icons/badge-96.png`, `/apple-touch-icon.png` → 200 image/png |
| Secure cookies | sign in; DevTools → cookies `dt_access`/`dt_refresh` are Secure, HttpOnly, SameSite=Lax |
| Push config | `curl https://<domain>/api/v1/push/vapid-public-key` → `{ "enabled": true, "publicKey": "B…" }` |
| Push end to end | Notification settings → Enable → Send test notification on a phone (real-device checklist) |

## Estimated monthly cost (USD, approximate — updated for the enterprise release)

Assumptions: on-demand list prices (us-east-1 reference; **eu-north-1 (Stockholm, the chosen region) is ~0–10 % higher**, me-central-1 ~10–20 % higher), 730 h/month, ≤ 50 users, ~20 GB/month NAT traffic, 50 GB of files, ~5 GB/month logs, no free tier, no Savings Plans/Reserved Instances, taxes excluded. Fargate: $0.04048 per vCPU-h + $0.004445 per GB-h. **Verify with the AWS Pricing Calculator for the chosen region before approving.**

| Item | Staging | Production |
|---|---:|---:|
| **Compute** — ECS Fargate (staging: api + web 0.25 vCPU/0.5 GB, worker 0.5/1 GB for Chromium; prod: 2 api + 2 web 0.5/1 GB, worker 0.5/2 GB; autoscaling peaks extra) | ~36 | ~93 |
| **Database** — RDS PostgreSQL 16 (staging t4g.micro single-AZ 20 GB gp3; prod t4g.medium Multi-AZ 50 GB gp3) | ~14 | ~107 |
| **Backups** — automated snapshots up to the DB size are free; PITR logs; manual pre-release snapshots (~$0.095/GB-month) | ~0–2 | ~2–5 |
| **NAT gateway(s)** (1 / 2) incl. data processing | ~34 | ~67 |
| **Load balancer** — ALB + LCUs | ~20 | ~25 |
| Public IPv4 addresses (ALB ×2 AZ + NAT EIPs, $0.005/h each) | ~11 | ~15 |
| **Logs & monitoring** — CloudWatch logs (14 / 90 days), Container Insights (enhanced in prod), 10 alarms, metric filters | ~5 | ~20–35 |
| **Storage** — S3 files/documents/reports + requests; ECR images | ~2 | ~3–5 |
| **Data transfer** out to the internet (first 100 GB/month free) | ~0 | ~0–5 |
| **Secrets** — Secrets Manager (RDS, personal-data key; VAPID) 3 × $0.40 | ~1.2 | ~1.2 |
| **Domain & DNS** — Route 53 hosted zone $0.50 + queries; domain registration ~$13–15/year if bought via Route 53 | ~0.6 (+domain) | ~0.6 (+domain) |
| **Notifications** — SQS, EventBridge Scheduler, SNS alarms; Web Push via browser push services (free) | <1 | <1 |
| **E-mail** — Cognito default sender (staging) / SES for production (~$0.10 per 1 000 e-mails) | 0 | <1 |
| Cognito (Lite tier, < 10 000 MAU), ACM certificate | 0 | 0 |
| **Total (us-east-1 reference)** | **≈ $125 / month** | **≈ $335–360 / month** |
| **Rough eu-north-1 estimate (chosen region)** | **≈ $130–140** | **≈ $365–405** (incl. WAF) |
| AWS WAF (production: web ACL + 5 rules + logs) | — | ~$12–15 (included in PRODUCTION_PLAN.md §10) |

Biggest levers: 1-year Compute Savings Plan (≈ −20–30 % on Fargate), RDS Reserved Instance (≈ −30–40 %), Fargate Spot for staging, a single NAT gateway in production (−$33, less AZ resilience), stopping staging outside working hours (−~40 % of staging compute; RDS can be stopped up to 7 days). Set an **AWS Budget** alert (e.g. $150 staging, $450 production).

## Security notes
* No public S3 access; all object access is via short-lived pre-signed URLs issued after authorization.
* Database only reachable from api/worker security groups; credentials only via Secrets Manager; TLS enforced.
* Tasks run as non-root with `tini` as PID 1; secrets are never baked into images.
* `AUTH_MODE=local`, the development VAPID key and insecure push endpoints are rejected in production.
* Full audit: docs/SECURITY_AUDIT.md.
