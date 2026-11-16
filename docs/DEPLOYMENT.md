# Deployment (AWS)

> **Nothing has been deployed.** Every step below creates chargeable AWS resources and must be run deliberately by an operator.

## Stacks (`infrastructure/aws-cdk`)
| Stack | Contents |
|---|---|
| `DailyTasks-Registry` | ECR repositories `dailytasks/api`, `dailytasks/worker`, `dailytasks/web` (immutable tags, scan on push) |
| `DailyTasks-staging` / `DailyTasks-production` | VPC (public / private-egress / isolated subnets), ALB, ECS Fargate services (api, web, worker) + migration task, RDS PostgreSQL 16 (encrypted, private, TLS enforced), private S3 bucket, SQS queue + DLQ, EventBridge Scheduler group + role, Cognito user pool + app client, Secrets Manager DB credentials, CloudWatch logs, alarms (DLQ, queue age, 5xx, CPU, DB storage, worker errors) → SNS |

Sizing per environment is in `lib/config.ts` (staging: single-AZ `t4g.micro`, 1 NAT, 1 task each; production: Multi-AZ `t4g.medium`, 2 NAT, ≥2 api/web tasks, autoscaling, deletion protection).

## Context parameters
| Key | Meaning |
|---|---|
| `imageTag` / `<env>:imageTag` | Immutable image tag to run (required for a real deploy) |
| `<env>:certificateArn` | ACM certificate → HTTPS listener, HTTP→HTTPS redirect, Secure cookies |
| `<env>:publicUrl` | Public URL (CORS + S3 CORS); defaults to ALB DNS |
| `alarmEmail` | E-mail subscribed to alarms |
| `<env>:expoAccessTokenSecretArn` | Secrets Manager secret with the Expo access token (optional) |
| `account`, `region` | Target account/region (default: current CLI profile, `me-central-1`) |

## First-time setup
1. `npx cdk bootstrap aws://<account>/<region>` (once per account/region).
2. `pnpm --filter @dailytasks/aws-cdk run deploy:registry`
3. `AWS_ACCOUNT_ID=<id> AWS_REGION=<region> scripts/push-images.sh` → prints the tag.
4. `pnpm --filter @dailytasks/aws-cdk exec cdk deploy DailyTasks-staging -c imageTag=<tag> -c alarmEmail=ops@example.com [-c staging:certificateArn=...]`
5. Run migrations (one-off task; values from stack outputs):
   ```bash
   aws ecs run-task --cluster dailytasks-staging --launch-type FARGATE \
     --task-definition <MigrateTaskDefinition> \
     --network-configuration "awsvpcConfiguration={subnets=[<MigrateSubnets>],securityGroups=[<MigrateSecurityGroup>]}"
   ```
6. Create the first admin: add a `Company` row and a `User` row (`role=COMPANY_ADMIN`, the admin's e-mail) via the migration task / a bastion session, then create the Cognito user with `aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <email>`. The admin signs in, sets a password, and invites everyone else from the portal (Team page).
7. Point DNS (Route 53 alias) at the ALB and set `publicUrl`.

## Releases
`push-images.sh` → `cdk deploy DailyTasks-<env> -c imageTag=<tag>` → run the migration task. ECS deployment circuit breakers roll back failed releases. Promote the same tag from staging to production.

## Mobile push (when the Expo app is built)
* `eas init` to obtain an EAS project id; configure APNs key (iOS) and FCM v1 service account (Android) in EAS credentials.
* Optional: enable Expo "enhanced push security", store the access token in Secrets Manager and pass `<env>:expoAccessTokenSecretArn`.
* Set `EXPO_PUBLIC_API_URL` to the `ApiUrl` stack output.

## Security notes
* No public S3 access; all object access is via short-lived pre-signed URLs issued after authorization.
* Database only reachable from api/worker security groups; credentials only via Secrets Manager.
* Tasks run as non-root; secrets are never baked into images.
* `AUTH_MODE=local` is rejected in production.
