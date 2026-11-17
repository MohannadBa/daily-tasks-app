#!/usr/bin/env bash
# Staging deployment driven by .env.staging (copy .env.staging.example). Works in AWS CloudShell.
#
#   scripts/deploy-staging.sh check      validate settings + credentials, offline synth (changes nothing)
#   scripts/deploy-staging.sh bootstrap  cdk bootstrap (once per account/region)
#   scripts/deploy-staging.sh registry   ECR repositories (DailyTasks-Registry)
#   scripts/deploy-staging.sh images     build + push api/worker/web (needs Docker; your PC is more reliable than CloudShell)
#   scripts/deploy-staging.sh vapid      create the staging Web Push key pair (private key → Secrets Manager)
#   scripts/deploy-staging.sh diff       show what the deploy would change (changes nothing)
#   scripts/deploy-staging.sh deploy     cdk deploy DailyTasks-staging
#   scripts/deploy-staging.sh migrate    run database migrations (one-off ECS task) and wait for the result
#   scripts/deploy-staging.sh admin      create the first company + admin (DB row + Cognito invitation e-mail)
#   scripts/deploy-staging.sh outputs    print the stack outputs
#   scripts/deploy-staging.sh destroy    delete the staging stack (database, files and logins are lost)
#
# Every step that creates, changes or deletes AWS resources asks for confirmation first.
# Secrets are never printed. Set ENV_FILE to use another settings file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.staging}"
STACK=DailyTasks-staging
CDK_DIR="$ROOT/infrastructure/aws-cdk"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
confirm() {
  echo
  echo "About to: $1"
  echo "Account $AWS_ACCOUNT_ID, region $AWS_REGION. This creates/changes AWS resources and may cost money."
  read -r -p "Type 'yes' to continue: " ans
  [ "$ans" = "yes" ] || die "cancelled"
}

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run: cp .env.staging.example .env.staging and fill it in."
set -a
# shellcheck disable=SC1090
. "$ENV_FILE" || die "could not read $ENV_FILE — quote values that contain spaces, e.g. ADMIN_NAME=\"Amal Ahmed\""
set +a

for v in AWS_ACCOUNT_ID AWS_REGION DOMAIN HOSTED_ZONE_NAME ALARM_EMAIL; do
  [ -n "${!v:-}" ] || die "$v is empty in $ENV_FILE"
done
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "AWS_ACCOUNT_ID must be 12 digits"
[[ "$DOMAIN" == *".$HOSTED_ZONE_NAME" || "$DOMAIN" == "$HOSTED_ZONE_NAME" ]] || die "DOMAIN ($DOMAIN) is not inside HOSTED_ZONE_NAME ($HOSTED_ZONE_NAME)"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID" CDK_DEFAULT_REGION="$AWS_REGION"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}"
VAPID_SECRET_NAME="${VAPID_SECRET_NAME:-dailytasks/staging/vapid-private-key}"

need_aws() {
  command -v aws >/dev/null || die "AWS CLI not found"
  local acct
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || die "no valid AWS credentials"
  [ "$acct" = "$AWS_ACCOUNT_ID" ] || die "credentials belong to account $acct, but .env.staging says $AWS_ACCOUNT_ID — refusing"
}
zone_id() {
  if [ -n "${HOSTED_ZONE_ID:-}" ]; then echo "$HOSTED_ZONE_ID"; return; fi
  local id
  id=$(aws route53 list-hosted-zones-by-name --dns-name "$HOSTED_ZONE_NAME" --max-items 1 \
    --query "HostedZones[?Name=='${HOSTED_ZONE_NAME%.}.'] | [0].Id" --output text 2>/dev/null | sed 's#/hostedzone/##')
  [ -n "$id" ] && [ "$id" != "None" ] || die "no Route 53 hosted zone named $HOSTED_ZONE_NAME in this account"
  echo "$id"
}
vapid_arn() { aws secretsmanager describe-secret --secret-id "$VAPID_SECRET_NAME" --query ARN --output text 2>/dev/null || true; }
context() {
  local arn
  arn=$(vapid_arn)
  [ -n "${VAPID_PUBLIC_KEY:-}" ] && [ -n "$arn" ] || die "Web Push keys missing — run: scripts/deploy-staging.sh vapid"
  CTX=(-c "account=$AWS_ACCOUNT_ID" -c "region=$AWS_REGION" -c "imageTag=$IMAGE_TAG"
    -c "staging:domainName=$DOMAIN" -c "hostedZoneId=$(zone_id)" -c "hostedZoneName=$HOSTED_ZONE_NAME"
    -c "staging:vapidPublicKey=$VAPID_PUBLIC_KEY" -c "staging:vapidPrivateKeySecretArn=$arn" -c "alarmEmail=$ALARM_EMAIL")
  if [ -n "${VAPID_SUBJECT:-}" ]; then CTX+=(-c "staging:vapidSubject=$VAPID_SUBJECT"); fi
}
cdk() { (cd "$CDK_DIR" && npx cdk "$@"); }
out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
run_one_off() { # $1 = description, $2 = optional --overrides JSON
  local cluster td net task code
  cluster=$(out ClusterName); td=$(out MigrateTaskDefinition)
  net="awsvpcConfiguration={subnets=[$(out MigrateSubnets)],securityGroups=[$(out MigrateSecurityGroup)],assignPublicIp=DISABLED}"
  local args=(--cluster "$cluster" --launch-type FARGATE --task-definition "$td" --network-configuration "$net")
  if [ -n "${2:-}" ]; then args+=(--overrides "$2"); fi
  task=$(aws ecs run-task "${args[@]}" --query 'tasks[0].taskArn' --output text)
  [ -n "$task" ] && [ "$task" != "None" ] || die "could not start the $1 task"
  info "$1 task started (${task##*/}); waiting for it to finish…"
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  info "logs: CloudWatch log group /dailytasks/staging/migrate, stream migrate/migrate/${task##*/}"
  [ "$code" = "0" ] || die "$1 task failed (exit code $code) — check the logs above"
  info "$1: OK"
}

case "${1:-}" in
  check)
    command -v node >/dev/null || die "Node.js not found (need >= 22.12)"
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' || die "Node $(node -v) is too old (need >= 22.12)"
    need_aws
    info "account $AWS_ACCOUNT_ID, region $AWS_REGION: credentials OK"
    info "hosted zone $HOSTED_ZONE_NAME: $(zone_id)"
    info "domain https://$DOMAIN, image tag $IMAGE_TAG, alarms → $ALARM_EMAIL"
    if aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then info "CDK bootstrap: present"; else info "CDK bootstrap: MISSING (run: bootstrap)"; fi
    if aws ecr describe-repositories --repository-names dailytasks/api >/dev/null 2>&1; then
      info "registry: present"
      for s in api worker web; do
        aws ecr describe-images --repository-name "dailytasks/$s" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 && info "image $s:$IMAGE_TAG present" || info "image $s:$IMAGE_TAG MISSING (run: images)"
      done
    else info "registry: MISSING (run: registry)"; fi
    if [ -n "$(vapid_arn)" ] && [ -n "${VAPID_PUBLIC_KEY:-}" ]; then info "Web Push keys: present"; else info "Web Push keys: MISSING (run: vapid)"; fi
    if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then info "$STACK: deployed"; else info "$STACK: not deployed"; fi
    ;;
  bootstrap)
    need_aws; confirm "bootstrap CDK in aws://$AWS_ACCOUNT_ID/$AWS_REGION (S3 bucket + roles for deployments)"
    cdk bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION"
    ;;
  registry)
    need_aws; confirm "deploy DailyTasks-Registry (3 ECR repositories)"
    cdk deploy DailyTasks-Registry -c "account=$AWS_ACCOUNT_ID" -c "region=$AWS_REGION" --require-approval never
    ;;
  images)
    need_aws; command -v docker >/dev/null || die "Docker not found — build the images on a machine with Docker"
    confirm "build and push api/worker/web images with tag $IMAGE_TAG"
    AWS_ACCOUNT_ID="$AWS_ACCOUNT_ID" AWS_REGION="$AWS_REGION" "$ROOT/scripts/push-images.sh" "$IMAGE_TAG"
    ;;
  vapid)
    need_aws
    if [ -n "$(vapid_arn)" ]; then
      [ -n "${VAPID_PUBLIC_KEY:-}" ] || die "secret $VAPID_SECRET_NAME exists but VAPID_PUBLIC_KEY is empty — restore the matching public key into $ENV_FILE (or delete the secret and rerun)"
      info "Web Push keys already exist — nothing to do"; exit 0
    fi
    confirm "create the staging Web Push key pair; private key → Secrets Manager $VAPID_SECRET_NAME"
    keys=$(cd "$ROOT" && node scripts/generate-vapid-keys.mjs)
    pub=$(printf '%s\n' "$keys" | sed -n 's/^WEB_PUSH_VAPID_PUBLIC_KEY=//p')
    priv=$(printf '%s\n' "$keys" | sed -n 's/^WEB_PUSH_VAPID_PRIVATE_KEY=//p')
    unset keys
    [ -n "$pub" ] && [ -n "$priv" ] || die "key generation failed (run pnpm install first)"
    aws secretsmanager create-secret --name "$VAPID_SECRET_NAME" --description "DailyTasks staging Web Push private key (worker only)" \
      --secret-string "$priv" --query ARN --output text >/dev/null
    unset priv
    if grep -q '^VAPID_PUBLIC_KEY=' "$ENV_FILE"; then sed -i "s#^VAPID_PUBLIC_KEY=.*#VAPID_PUBLIC_KEY=$pub#" "$ENV_FILE"; else echo "VAPID_PUBLIC_KEY=$pub" >>"$ENV_FILE"; fi
    info "private key stored in Secrets Manager; public key written to $ENV_FILE"
    ;;
  diff)
    need_aws; context; cdk diff "$STACK" "${CTX[@]}"
    ;;
  deploy)
    need_aws; context
    for s in api worker web; do
      aws ecr describe-images --repository-name "dailytasks/$s" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 || die "image dailytasks/$s:$IMAGE_TAG not in ECR — run: images"
    done
    confirm "deploy $STACK (VPC, NAT, ALB/HTTPS, ECS, RDS, S3, SQS, Cognito… ≈ \$130–140/month) with image $IMAGE_TAG"
    cdk deploy "$STACK" "${CTX[@]}" --require-approval broadening
    info "next: scripts/deploy-staging.sh migrate"
    ;;
  migrate)
    need_aws; confirm "run database migrations on staging"
    run_one_off migrate
    ;;
  admin)
    need_aws
    for v in COMPANY_NAME ADMIN_EMAIL ADMIN_NAME; do [ -n "${!v:-}" ] || die "$v is empty in $ENV_FILE"; done
    confirm "create company '$COMPANY_NAME' and admin $ADMIN_EMAIL (Cognito e-mails a temporary password)"
    overrides=$(node -e '
      const e=(n,v)=>({name:n,value:v});
      process.stdout.write(JSON.stringify({containerOverrides:[{name:"migrate",command:["node","/app/packages/database/dist/bootstrap-admin.js"],
        environment:[e("BOOTSTRAP_COMPANY_NAME",process.env.COMPANY_NAME),e("BOOTSTRAP_ADMIN_EMAIL",process.env.ADMIN_EMAIL),
          e("BOOTSTRAP_ADMIN_NAME",process.env.ADMIN_NAME),e("BOOTSTRAP_ADMIN_LOCALE",process.env.ADMIN_LOCALE||"ar")]}]}))')
    run_one_off bootstrap-admin "$overrides"
    aws cognito-idp admin-create-user --user-pool-id "$(out UserPoolId)" --username "$ADMIN_EMAIL" --desired-delivery-mediums EMAIL \
      --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true --query 'User.UserStatus' --output text
    info "invitation e-mailed to $ADMIN_EMAIL — sign in at https://$DOMAIN"
    info "NOW back up the personal-data key (docs/OPERATIONS.md §8): aws secretsmanager get-secret-value --secret-id dailytasks-staging/personal-data-key"
    ;;
  outputs)
    need_aws
    aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
    ;;
  destroy)
    need_aws; context
    confirm "DESTROY $STACK — the database (no final snapshot), all uploaded files and all logins are deleted"
    read -r -p "Type the stack name ($STACK) to confirm: " ans
    [ "$ans" = "$STACK" ] || die "cancelled"
    cdk destroy "$STACK" "${CTX[@]}" --force
    info "left in place: secrets $VAPID_SECRET_NAME and dailytasks-staging/personal-data-key, ECR images, CDK bootstrap (see docs/STAGING_PLAN.md §8)"
    ;;
  *)
    sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
