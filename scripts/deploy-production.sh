#!/usr/bin/env bash
# Production deployment driven by .env.production (copy .env.production.example). Works in AWS CloudShell.
# Run the steps in this order the first time (docs/PRODUCTION_PLAN.md §5):
#
#   check          validate settings, credentials and readiness (changes nothing)
#   bootstrap      cdk bootstrap (once per account) in eu-north-1, eu-west-1 (backups) and us-east-1 (CloudFront WAF)
#   registry       ECR repositories (DailyTasks-Registry)
#   images         build + push api/worker/web (needs Docker; your PC is more reliable than CloudShell)
#   edge           DailyTasks-Edge in us-east-1: CloudFront WAF (needed while there is no custom domain)
#   mail           SES domain identity for Cognito e-mail (DailyTasks-Mail; needs a custom domain) — then wait for `check`
#   dr             DailyTasks-DR in eu-west-1: KMS key for replicated backups + isolated restore-drill network
#   vapid          Web Push key pair (private key → Secrets Manager, public key → .env.production)
#   diff           show what the deploy would change (changes nothing)
#   deploy         cdk deploy DailyTasks-production (also used to change the allow-list or open access)
#   migrate        manual DB snapshot, then database migrations (one-off task), with logs
#   tls-check      prove DB TLS: connects with the RDS CA, and is REFUSED with a public-only CA bundle
#   admin          first company + admin (DB row + Cognito invitation e-mail through SES)
#   snapshot       manual DB snapshot (before risky changes)
#   restore-drill  restore the DB to a temporary instance, verify it read-only (incl. personal-task decryption), delete it
#   dr-drill       restore the REPLICATED backup in eu-west-1 into the isolated drill network, check it, delete it
#   outputs        stack outputs
#
# Every step that creates or changes AWS resources asks you to type the stack name. There is no
# destroy command for production (deletion protection + termination protection are on).
# Secrets are never printed. Set ENV_FILE to use another settings file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env.production}"
STACK=DailyTasks-production
PREFIX=dailytasks-production
CDK_DIR="$ROOT/infrastructure/aws-cdk"
VAPID_SECRET_NAME="$PREFIX/vapid-private-key"
# Decided architecture (must match infrastructure/aws-cdk/lib/config.ts): production runs in Stockholm,
# backups are replicated to Ireland. Changing either is a deliberate code change, never an .env edit.
PRODUCTION_REGION=eu-north-1
DR_REGION=eu-west-1
DR_STACK=DailyTasks-DR
# CloudFront web ACLs must live in us-east-1.
EDGE_REGION=us-east-1
EDGE_STACK=DailyTasks-Edge

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
confirm() {
  echo
  echo "About to: $1"
  echo "PRODUCTION — account $AWS_ACCOUNT_ID, region $AWS_REGION. This creates/changes AWS resources and may cost money."
  read -r -p "Type the stack name ($STACK) to continue: " ans
  [ "$ans" = "$STACK" ] || die "cancelled"
}

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run: cp .env.production.example .env.production and fill it in."
set -a
# shellcheck disable=SC1090
. "$ENV_FILE" || die "could not read $ENV_FILE — quote values that contain spaces, e.g. ADMIN_NAME=\"Amal Ahmed\""
set +a

for v in AWS_ACCOUNT_ID AWS_REGION ACCESS_MODE; do
  [ -n "${!v:-}" ] || die "$v is empty in $ENV_FILE"
done
[[ "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]] || die "AWS_ACCOUNT_ID must be 12 digits"
DOMAIN="${DOMAIN:-}"; HOSTED_ZONE_NAME="${HOSTED_ZONE_NAME:-}"; SES_FROM_ADDRESS="${SES_FROM_ADDRESS:-}"; ALARM_EMAIL="${ALARM_EMAIL:-}"
# Custom domain is optional: without it the app is served at https://<id>.cloudfront.net (DailyTasks-Edge).
if [ -n "$DOMAIN" ]; then
  [ -n "$HOSTED_ZONE_NAME" ] || die "DOMAIN is set but HOSTED_ZONE_NAME is empty"
  [[ "$DOMAIN" == *".$HOSTED_ZONE_NAME" || "$DOMAIN" == "$HOSTED_ZONE_NAME" ]] || die "DOMAIN ($DOMAIN) is not inside HOSTED_ZONE_NAME ($HOSTED_ZONE_NAME)"
fi
if [ -n "$SES_FROM_ADDRESS" ]; then
  [ -n "$HOSTED_ZONE_NAME" ] || die "SES_FROM_ADDRESS needs a custom domain (HOSTED_ZONE_NAME)"
  [[ "${SES_FROM_ADDRESS,,}" == *"@${HOSTED_ZONE_NAME,,}" ]] || die "SES_FROM_ADDRESS must be an address @$HOSTED_ZONE_NAME"
fi
# Operations mailbox: optional until opening; never a placeholder (same rule as the CDK).
if [ -n "$ALARM_EMAIL" ]; then
  [[ "$ALARM_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "ALARM_EMAIL is not a valid e-mail address"
  [[ "${ALARM_EMAIL##*@}" =~ (^|\.)(example\.(com|org|net)|test|invalid|localhost|local)$ ]] && die "ALARM_EMAIL uses a placeholder domain — set a real operations mailbox or leave it empty"
fi
case "$ACCESS_MODE" in
  restricted)
    [ -n "${ACCESS_ALLOWLIST:-}" ] || die "ACCESS_MODE=restricted needs ACCESS_ALLOWLIST"
    if [ -n "${ADMIN_EMAIL:-}" ] && [[ ",${ACCESS_ALLOWLIST,,}," != *",${ADMIN_EMAIL,,},"* ]]; then die "ADMIN_EMAIL must be in ACCESS_ALLOWLIST"; fi
    ;;
  open)
    # Owner decision 2026-11-17 (option C): open access is allowed without a custom domain, SES or an
    # operations mailbox. These are ACCEPTED RISKS (docs/SECURITY_AUDIT.md) and are shown, not blocked.
    OPEN_RISKS=()
    [ -n "$DOMAIN" ] || OPEN_RISKS+=("no custom domain: CloudFront address with the TLSv1 security policy (TLS 1.0/1.1 not refused)")
    [ -n "$SES_FROM_ADDRESS" ] || OPEN_RISKS+=("no SES: Cognito default sender, about 50 e-mails/day — create accounts with 'show temporary password once'")
    [ -n "$ALARM_EMAIL" ] || OPEN_RISKS+=("no operations mailbox: alarms notify nobody")
    ;;
  *) die "ACCESS_MODE must be restricted or open" ;;
esac
[ "$AWS_REGION" = "$PRODUCTION_REGION" ] || die "AWS_REGION in $ENV_FILE is '$AWS_REGION' — production is fixed to $PRODUCTION_REGION (backups to $DR_REGION). Refusing."
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID" CDK_DEFAULT_REGION="$AWS_REGION"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}"

need_aws() {
  command -v aws >/dev/null || die "AWS CLI not found"
  # Region the AWS CLI will actually use (local check, no network call): must be the production region.
  local cli_region
  # Works with both output formats: "region  eu-north-1  env …" (older CLI v2) and
  # "region : eu-north-1 : env : …" (newer CLI v2, e.g. CloudShell) — first non-":" field after "region".
  cli_region=$(aws configure list 2>/dev/null | awk '$1=="region"{for(i=2;i<=NF;i++) if($i!=":"){print $i; exit}}')
  [ "$cli_region" = "$PRODUCTION_REGION" ] || die "the AWS CLI resolves region '${cli_region:-<none>}', expected $PRODUCTION_REGION — refusing"
  local acct
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || die "no valid AWS credentials"
  [ "$acct" = "$AWS_ACCOUNT_ID" ] || die "credentials belong to account $acct, but $ENV_FILE says $AWS_ACCOUNT_ID — refusing"
}
zone_id() {
  [ -n "$HOSTED_ZONE_NAME" ] || die "no custom domain configured (HOSTED_ZONE_NAME is empty)"
  if [ -n "${HOSTED_ZONE_ID:-}" ]; then echo "$HOSTED_ZONE_ID"; return; fi
  local id
  id=$(aws route53 list-hosted-zones-by-name --dns-name "$HOSTED_ZONE_NAME" --max-items 1 \
    --query "HostedZones[?Name=='${HOSTED_ZONE_NAME%.}.'] | [0].Id" --output text 2>/dev/null | sed 's#/hostedzone/##')
  [ -n "$id" ] && [ "$id" != "None" ] || die "no Route 53 hosted zone named $HOSTED_ZONE_NAME in this account"
  echo "$id"
}
vapid_arn() { aws secretsmanager describe-secret --secret-id "$VAPID_SECRET_NAME" --query ARN --output text 2>/dev/null || true; }
mail_verified() { [ "$(aws sesv2 get-email-identity --email-identity "$HOSTED_ZONE_NAME" --query VerifiedForSendingStatus --output text 2>/dev/null)" = "True" ]; }
context() {
  local arn
  arn=$(vapid_arn)
  [ -n "${VAPID_PUBLIC_KEY:-}" ] && [ -n "$arn" ] || die "Web Push keys missing — run: vapid"
  CTX=(-c "account=$AWS_ACCOUNT_ID" -c "region=$AWS_REGION" -c "imageTag=$IMAGE_TAG"
    -c "production:vapidPublicKey=$VAPID_PUBLIC_KEY" -c "production:vapidPrivateKeySecretArn=$arn"
    -c "production:accessMode=$ACCESS_MODE" -c "production:backupReplicaKmsKeyArn=$(dr_key)")
  if [ -n "$DOMAIN" ]; then
    CTX+=(-c "production:domainName=$DOMAIN")
  else
    CTX+=(-c "production:edgeWebAclArn=$(edge_acl)")   # CloudFront domain until a custom domain exists
  fi
  [ -n "$HOSTED_ZONE_NAME" ] && CTX+=(-c "hostedZoneId=$(zone_id)" -c "hostedZoneName=$HOSTED_ZONE_NAME")
  [ -n "$SES_FROM_ADDRESS" ] && CTX+=(-c "production:sesFromAddress=$SES_FROM_ADDRESS")
  [ -n "$ALARM_EMAIL" ] && CTX+=(-c "alarmEmail=$ALARM_EMAIL")
  [ "$ACCESS_MODE" = "restricted" ] && CTX+=(-c "production:accessAllowlist=$ACCESS_ALLOWLIST")
  [ -n "${SES_FROM_NAME:-}" ] && CTX+=(-c "production:sesFromName=$SES_FROM_NAME")
  [ -n "${VAPID_SUBJECT:-}" ] && CTX+=(-c "production:vapidSubject=$VAPID_SUBJECT")
  [ -n "${ALLOWED_CIDRS:-}" ] && CTX+=(-c "production:allowedCidrs=$ALLOWED_CIDRS")
  [ -n "${WAF_RATE_LIMIT:-}" ] && CTX+=(-c "production:wafRateLimit=$WAF_RATE_LIMIT")
  [ -n "${WAF_AUTH_RATE_LIMIT:-}" ] && CTX+=(-c "production:wafAuthRateLimit=$WAF_AUTH_RATE_LIMIT")
  return 0
}
cdk() { (cd "$CDK_DIR" && npx cdk "$@"); }
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
db_id() { out DatabaseInstanceId; }
edge_out() { aws cloudformation describe-stacks --region "$EDGE_REGION" --stack-name "$EDGE_STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }
edge_acl() {
  local a
  a=$(edge_out WebAclArn)
  [[ "$a" == arn:aws:wafv2:$EDGE_REGION:$AWS_ACCOUNT_ID:global/webacl/* ]] || die "$EDGE_STACK not deployed in $EDGE_REGION (run: edge)"
  echo "$a"
}
dr_out() { aws cloudformation describe-stacks --region "$DR_REGION" --stack-name "$DR_STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }
dr_key() {
  local k
  k=$(dr_out BackupKeyArn)
  [[ "$k" == arn:aws:kms:$DR_REGION:$AWS_ACCOUNT_ID:key/* ]] || die "$DR_STACK not deployed in $DR_REGION (run: dr)"
  echo "$k"
}

# run_one_off <label> <task-def output key> <container> [overrides JSON] [expected exit code]
run_one_off() {
  local label=$1 tdkey=$2 container=$3 overrides=${4:-} expect=${5:-0}
  local cluster td net task code
  cluster=$(out ClusterName); td=$(out "$tdkey")
  net="awsvpcConfiguration={subnets=[$(out MigrateSubnets)],securityGroups=[$(out MigrateSecurityGroup)],assignPublicIp=DISABLED}"
  local args=(--cluster "$cluster" --launch-type FARGATE --task-definition "$td" --network-configuration "$net")
  [ -n "$overrides" ] && args+=(--overrides "$overrides")
  task=$(aws ecs run-task "${args[@]}" --query 'tasks[0].taskArn' --output text)
  [ -n "$task" ] && [ "$task" != "None" ] || die "could not start the $label task"
  info "$label task started (${task##*/}); waiting for it to finish…"
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  local group="/dailytasks/production/$container" stream
  stream="$container/$container/${task##*/}"
  info "last log lines ($group):"
  aws logs get-log-events --log-group-name "$group" --log-stream-name "$stream" --limit 25 --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' | sed 's/^/    /' || true
  [ "$code" = "$expect" ] || die "$label: exit code $code (expected $expect)"
  info "$label: OK"
}
snapshot() {
  local id snap
  id=$(db_id)
  snap="$PREFIX-$1-$(date -u +%Y%m%d-%H%M%S)"
  info "creating manual snapshot $snap (kept until you delete it)…"
  aws rds create-db-snapshot --db-instance-identifier "$id" --db-snapshot-identifier "$snap" --tags Key=app,Value=dailytasks Key=reason,Value="$1" >/dev/null
  aws rds wait db-snapshot-available --db-snapshot-identifier "$snap"
  info "snapshot $snap available — record it in the release log"
  # Off-site copy in Ireland (manual snapshots are never deleted automatically). Runs in the background at AWS.
  local arn
  arn=$(aws rds describe-db-snapshots --db-snapshot-identifier "$snap" --query 'DBSnapshots[0].DBSnapshotArn' --output text)
  aws rds copy-db-snapshot --region "$DR_REGION" --source-region "$AWS_REGION" --source-db-snapshot-identifier "$arn" \
    --target-db-snapshot-identifier "$snap" --kms-key-id "$(dr_key)" --copy-tags >/dev/null
  info "copy of $snap to $DR_REGION started (encrypted with the Ireland backup key)"
}

case "${1:-}" in
  check)
    command -v node >/dev/null || die "Node.js not found (need >= 22.12)"
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' || die "Node $(node -v) is too old (need >= 22.12)"
    need_aws
    info "account $AWS_ACCOUNT_ID, region $AWS_REGION: credentials OK"
    if [ -n "$DOMAIN" ]; then info "custom domain https://$DOMAIN (hosted zone $HOSTED_ZONE_NAME: $(zone_id))"; else info "no custom domain: served at the CloudFront domain (needs $EDGE_STACK)"; fi
    info "image $IMAGE_TAG"
    [ -n "$ALARM_EMAIL" ] && info "alarm e-mail: $ALARM_EMAIL (confirm the SNS subscription e-mail after deploy)" || info "alarm e-mail: NOT CONFIGURED — alarms fire without notification (set ALARM_EMAIL; required before opening)"
    if [ "$ACCESS_MODE" = restricted ]; then info "launch gate: RESTRICTED ($(echo "$ACCESS_ALLOWLIST" | tr ',' '\n' | grep -c .) allow-listed account(s))"; else info "launch gate: OPEN (all provisioned accounts)"; fi
    aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1 && info "CDK bootstrap: present" || info "CDK bootstrap: MISSING (run: bootstrap)"
    if aws ecr describe-repositories --repository-names dailytasks/api >/dev/null 2>&1; then
      for s in api worker web; do
        aws ecr describe-images --repository-name "dailytasks/$s" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 && info "image $s:$IMAGE_TAG present" || info "image $s:$IMAGE_TAG MISSING (run: images)"
      done
    else info "registry: MISSING (run: registry)"; fi
    if [ -z "$SES_FROM_ADDRESS" ]; then info "SES: not configured — Cognito default sender (≈50 e-mails/day) during restricted acceptance; required before opening"
    elif mail_verified; then info "SES identity $HOSTED_ZONE_NAME: VERIFIED"; else info "SES identity $HOSTED_ZONE_NAME: NOT VERIFIED (run: mail, then wait)"; fi
    if [ -z "$DOMAIN" ]; then
      a=$(edge_out WebAclArn); [ -n "$a" ] && [ "$a" != None ] && info "$EDGE_STACK ($EDGE_REGION): deployed" || info "$EDGE_STACK ($EDGE_REGION): not deployed (run: edge)"
    fi
    if [ -n "$SES_FROM_ADDRESS" ]; then
      if [ "$(aws sesv2 get-account --query ProductionAccessEnabled --output text 2>/dev/null)" = "True" ]; then info "SES account: production access"
      else info "SES account: SANDBOX (only verified addresses/domains receive mail — request production access before opening to employees)"; fi
    fi
    [ -n "$(vapid_arn)" ] && [ -n "${VAPID_PUBLIC_KEY:-}" ] && info "Web Push keys: present" || info "Web Push keys: MISSING (run: vapid)"
    aws cloudformation describe-stacks --region "$DR_REGION" --stack-name CDKToolkit >/dev/null 2>&1 && info "CDK bootstrap $DR_REGION: present" || info "CDK bootstrap $DR_REGION: MISSING (run: bootstrap)"
    k=$(dr_out BackupKeyArn); [ -n "$k" ] && [ "$k" != None ] && info "$DR_STACK ($DR_REGION): deployed, backup key present" || info "$DR_STACK ($DR_REGION): not deployed (run: dr)"
    if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
      info "$STACK: deployed (access mode $(out AccessMode))"
      rep=$(aws rds describe-db-instance-automated-backups --region "$DR_REGION" --db-instance-identifier "$(db_id)" \
        --query 'DBInstanceAutomatedBackups[0].[Status,RestoreWindow.LatestTime,BackupRetentionPeriod]' --output text 2>/dev/null || true)
      info "backup replication to $DR_REGION: ${rep:-none yet} (status, latest restorable time, retention days)"
    else info "$STACK: not deployed"; fi
    ;;
  bootstrap)
    need_aws; confirm "bootstrap CDK in aws://$AWS_ACCOUNT_ID/$AWS_REGION, /$DR_REGION and /$EDGE_REGION"
    cdk bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION" "aws://$AWS_ACCOUNT_ID/$DR_REGION" "aws://$AWS_ACCOUNT_ID/$EDGE_REGION"
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
  edge)
    need_aws; confirm "deploy $EDGE_STACK in $EDGE_REGION: CloudFront WAF (managed rules, rate limits, logs; ≈ \$12–15/month)"
    ECTX=(-c "account=$AWS_ACCOUNT_ID" -c "region=$AWS_REGION")
    [ -n "$ALARM_EMAIL" ] && ECTX+=(-c "alarmEmail=$ALARM_EMAIL")
    [ -n "${ALLOWED_CIDRS:-}" ] && ECTX+=(-c "production:allowedCidrs=$ALLOWED_CIDRS")
    [ -n "${WAF_RATE_LIMIT:-}" ] && ECTX+=(-c "production:wafRateLimit=$WAF_RATE_LIMIT")
    [ -n "${WAF_AUTH_RATE_LIMIT:-}" ] && ECTX+=(-c "production:wafAuthRateLimit=$WAF_AUTH_RATE_LIMIT")
    cdk deploy "$EDGE_STACK" "${ECTX[@]}" --require-approval broadening
    info "web ACL: $(edge_acl)"
    ;;
  mail)
    [ -n "$HOSTED_ZONE_NAME" ] || die "SES needs a custom domain: set HOSTED_ZONE_NAME (see docs/PRODUCTION_PLAN.md §13)"
    need_aws; confirm "deploy DailyTasks-Mail: SES identity for $HOSTED_ZONE_NAME (adds DKIM CNAMEs + ses-bounce MX/SPF records to the zone)"
    cdk deploy DailyTasks-Mail -c "account=$AWS_ACCOUNT_ID" -c "region=$AWS_REGION" -c "hostedZoneId=$(zone_id)" -c "hostedZoneName=$HOSTED_ZONE_NAME" --require-approval never
    info "DKIM verification usually takes minutes (up to 72 h). Re-run: scripts/deploy-production.sh check"
    ;;
  dr)
    need_aws; confirm "deploy $DR_STACK in $DR_REGION: retained KMS key for replicated backups + isolated restore-drill network (≈ \$1–2/month)"
    cdk deploy "$DR_STACK" -c "account=$AWS_ACCOUNT_ID" -c "region=$AWS_REGION" --require-approval broadening
    info "backup key: $(dr_key)"
    ;;
  vapid)
    need_aws
    if [ -n "$(vapid_arn)" ]; then
      [ -n "${VAPID_PUBLIC_KEY:-}" ] || die "secret $VAPID_SECRET_NAME exists but VAPID_PUBLIC_KEY is empty — restore the matching public key into $ENV_FILE"
      info "Web Push keys already exist — nothing to do"; exit 0
    fi
    confirm "create the production Web Push key pair; private key → Secrets Manager $VAPID_SECRET_NAME"
    keys=$(cd "$ROOT" && node scripts/generate-vapid-keys.mjs)
    pub=$(printf '%s\n' "$keys" | sed -n 's/^WEB_PUSH_VAPID_PUBLIC_KEY=//p')
    priv=$(printf '%s\n' "$keys" | sed -n 's/^WEB_PUSH_VAPID_PRIVATE_KEY=//p')
    unset keys
    [ -n "$pub" ] && [ -n "$priv" ] || die "key generation failed (run pnpm install first)"
    aws secretsmanager create-secret --name "$VAPID_SECRET_NAME" --description "DailyTasks production Web Push private key (worker only)" \
      --secret-string "$priv" --tags Key=app,Value=dailytasks --query ARN --output text >/dev/null
    unset priv
    if grep -q '^VAPID_PUBLIC_KEY=' "$ENV_FILE"; then sed -i "s#^VAPID_PUBLIC_KEY=.*#VAPID_PUBLIC_KEY=$pub#" "$ENV_FILE"; else echo "VAPID_PUBLIC_KEY=$pub" >>"$ENV_FILE"; fi
    info "private key stored in Secrets Manager; public key written to $ENV_FILE"
    ;;
  diff)
    need_aws; context; cdk diff "$STACK" "${CTX[@]}"
    ;;
  deploy)
    need_aws; context
    if [ -n "$SES_FROM_ADDRESS" ]; then mail_verified || die "SES identity $HOSTED_ZONE_NAME is not verified yet — run: mail, then wait (check)"; fi
    for s in api worker web; do
      aws ecr describe-images --repository-name "dailytasks/$s" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 || die "image dailytasks/$s:$IMAGE_TAG not in ECR — run: images"
    done
    if [ "$ACCESS_MODE" = open ]; then
      echo; echo "!!! ACCESS_MODE=open: every provisioned account (all employees) will be able to sign in."
      for r in "${OPEN_RISKS[@]}"; do echo "    ACCEPTED RISK: $r"; done
      read -r -p "Type OPEN ACCESS to confirm: " ans
      [ "$ans" = "OPEN ACCESS" ] || die "cancelled"
    fi
    confirm "deploy $STACK with image $IMAGE_TAG, access mode $ACCESS_MODE (≈ \$365–405/month incl. WAF)"
    cdk deploy "$STACK" "${CTX[@]}" --require-approval broadening
    info "deployed at $(out AppUrl). First time: migrate → tls-check → admin"
    ;;
  snapshot)
    need_aws; confirm "create a manual snapshot of the production database"
    snapshot manual
    ;;
  migrate)
    need_aws; confirm "snapshot the production database, then run migrations with image $IMAGE_TAG"
    snapshot "pre-migrate-$IMAGE_TAG"
    run_one_off migrate MigrateTaskDefinition migrate
    ;;
  tls-check)
    need_aws; confirm "run two read-only database TLS checks (one-off tasks)"
    cmd='"command":["node","/app/packages/database/dist/db-tls-check.js"]'
    run_one_off "TLS positive (RDS CA)" MigrateTaskDefinition migrate "{\"containerOverrides\":[{\"name\":\"migrate\",$cmd}]}" 0
    run_one_off "TLS negative (public CAs only — must be refused)" MigrateTaskDefinition migrate \
      "{\"containerOverrides\":[{\"name\":\"migrate\",$cmd,\"environment\":[{\"name\":\"DB_SSL_CA_FILE\",\"value\":\"/etc/ssl/certs/ca-certificates.crt\"}]}]}" 3
    info "DB TLS: encrypted AND server certificate verified (record both log excerpts in docs/PRODUCTION_PLAN.md §7)"
    ;;
  admin)
    need_aws
    for v in COMPANY_NAME ADMIN_EMAIL ADMIN_NAME; do [ -n "${!v:-}" ] || die "$v is empty in $ENV_FILE"; done
    confirm "create company '$COMPANY_NAME' and admin $ADMIN_EMAIL (Cognito e-mails a temporary password via SES)"
    overrides=$(node -e '
      const e=(n,v)=>({name:n,value:v});
      process.stdout.write(JSON.stringify({containerOverrides:[{name:"migrate",command:["node","/app/packages/database/dist/bootstrap-admin.js"],
        environment:[e("BOOTSTRAP_COMPANY_NAME",process.env.COMPANY_NAME),e("BOOTSTRAP_ADMIN_EMAIL",process.env.ADMIN_EMAIL),
          e("BOOTSTRAP_ADMIN_NAME",process.env.ADMIN_NAME),e("BOOTSTRAP_ADMIN_LOCALE",process.env.ADMIN_LOCALE||"ar")]}]}))')
    run_one_off bootstrap-admin MigrateTaskDefinition migrate "$overrides"
    aws cognito-idp admin-create-user --user-pool-id "$(out UserPoolId)" --username "$ADMIN_EMAIL" --desired-delivery-mediums EMAIL \
      --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true --query 'User.UserStatus' --output text
    info "invitation e-mailed to $ADMIN_EMAIL — sign in at $(out AppUrl)"
    info "NOW escrow the personal-data key (docs/OPERATIONS.md §8): secret $PREFIX/personal-data-key"
    ;;
  restore-drill)
    need_aws
    src=$(db_id); drill="$PREFIX-drill-$(date -u +%m%d%H%M)"
    read -r subnetgrp paramgrp sg prod_endpoint < <(aws rds describe-db-instances --db-instance-identifier "$src" \
      --query 'DBInstances[0].[DBSubnetGroup.DBSubnetGroupName,DBParameterGroups[0].DBParameterGroupName,VpcSecurityGroups[0].VpcSecurityGroupId,Endpoint.Address]' --output text)
    [[ "$prod_endpoint" == *.rds.amazonaws.com ]] || die "could not read the production endpoint — refusing to run a drill"
    [[ "$drill" == "$PREFIX-drill-"* && "$drill" != "$src" ]] || die "unexpected drill identifier $drill — refusing"
    confirm "restore $src (latest restorable time) to temporary instance $drill, verify it read-only, then delete it (~\$0.10/hour while it exists)"
    aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$src" --target-db-instance-identifier "$drill" \
      --use-latest-restorable-time --db-subnet-group-name "$subnetgrp" --db-parameter-group-name "$paramgrp" --vpc-security-group-ids "$sg" \
      --no-multi-az --no-publicly-accessible --no-deletion-protection --tags Key=app,Value=dailytasks Key=purpose,Value=restore-drill >/dev/null
    t0=$(date +%s); info "restoring $drill (typically 10–30 min)…"
    aws rds wait db-instance-available --db-instance-identifier "$drill"
    info "restore completed in $(( ($(date +%s) - t0) / 60 )) min (record as RTO evidence)"
    endpoint=$(aws rds describe-db-instances --db-instance-identifier "$drill" --query 'DBInstances[0].Endpoint.Address' --output text || true)
    endpoint=$(printf '%s' "$endpoint" | tr 'A-Z' 'a-z')
    # R3 guard: the verifier must target the drill copy — never production (not even read-only, which
    # would also produce a false "PASSED"). The task itself re-checks via VERIFY_RESTORE_EXPECT_HOST.
    if [[ "$endpoint" == "$drill".*.rds.amazonaws.com && "$endpoint" != "${prod_endpoint,,}" ]]; then
      # Subshell: a failed verification must not skip the clean-up question below.
      if ( run_one_off verify-restore ApiTaskDefinition api \
        "{\"containerOverrides\":[{\"name\":\"api\",\"command\":[\"node\",\"/app/packages/database/dist/verify-restore.js\"],\"environment\":[{\"name\":\"DB_HOST_OVERRIDE\",\"value\":\"$endpoint\"},{\"name\":\"VERIFY_RESTORE_EXPECT_HOST\",\"value\":\"$endpoint\"}]}]}" 0 ); then
        drill_ok=yes
      else
        drill_ok=no
      fi
    else
      echo "  ✗ drill endpoint '${endpoint:-<empty>}' is not the drill instance's own endpoint — verification NOT run"
      drill_ok=no
    fi
    read -r -p "Delete the drill instance $drill now? (yes/no) " ans
    if [ "$ans" = "yes" ]; then
      # Only ever the drill instance created above (production also has deletion protection).
      [[ "$drill" == "$PREFIX-drill-"* && "$drill" != "$src" ]] || die "refusing to delete unexpected identifier $drill"
      aws rds delete-db-instance --db-instance-identifier "$drill" --skip-final-snapshot >/dev/null && info "deleting $drill"
    else info "remember to delete $drill (aws rds delete-db-instance --db-instance-identifier $drill --skip-final-snapshot)"; fi
    [ "$drill_ok" = yes ] && info "RESTORE DRILL PASSED" || die "RESTORE DRILL FAILED — see the verify-restore log above"
    ;;
  dr-drill)
    need_aws
    src=$(db_id); drill="$PREFIX-drdrill-$(date -u +%m%d%H%M)"
    read -r backup_arn latest status < <(aws rds describe-db-instance-automated-backups --region "$DR_REGION" --db-instance-identifier "$src" \
      --query 'DBInstanceAutomatedBackups[0].[DBInstanceAutomatedBackupsArn,RestoreWindow.LatestTime,Status]' --output text)
    [[ "$backup_arn" == arn:aws:rds:$DR_REGION:$AWS_ACCOUNT_ID:auto-backup:* ]] || die "no replicated automated backup of $src in $DR_REGION (status: ${status:-none})"
    subnets=$(dr_out DrillSubnetGroupName); sg=$(dr_out DrillSecurityGroupId); key=$(dr_key)
    [ -n "$subnets" ] && [[ "$sg" == sg-* ]] || die "$DR_STACK outputs missing (run: dr)"
    info "replicated backup found; latest restorable time in $DR_REGION: $latest (status $status)"
    confirm "restore the Ireland backup to temporary instance $drill in the isolated drill network ($DR_REGION), check it, then delete it (~\$0.10/hour while it exists)"
    aws rds restore-db-instance-to-point-in-time --region "$DR_REGION" --source-db-instance-automated-backups-arn "$backup_arn" \
      --target-db-instance-identifier "$drill" --use-latest-restorable-time --db-subnet-group-name "$subnets" --vpc-security-group-ids "$sg" \
      --db-instance-class db.t4g.medium --no-multi-az --no-publicly-accessible --no-deletion-protection \
      --tags Key=app,Value=dailytasks Key=purpose,Value=dr-drill >/dev/null
    t0=$(date +%s); info "restoring $drill in $DR_REGION (typically 15–45 min)…"
    aws rds wait db-instance-available --region "$DR_REGION" --db-instance-identifier "$drill"
    mins=$(( ($(date +%s) - t0) / 60 ))
    read -r enc kms engine status2 < <(aws rds describe-db-instances --region "$DR_REGION" --db-instance-identifier "$drill" \
      --query 'DBInstances[0].[StorageEncrypted,KmsKeyId,EngineVersion,DBInstanceStatus]' --output text)
    info "restored in $mins min: status=$status2 engine=$engine encrypted=$enc"
    ok=yes
    [ "$enc" = True ] || { ok=no; echo "  ✗ restored instance is not encrypted"; }
    [ "$kms" = "$key" ] || { ok=no; echo "  ✗ restored instance is not encrypted with the Ireland backup key"; }
    [ "$status2" = available ] || ok=no
    # Safety: only ever delete the drill instance created above.
    [[ "$drill" == "$PREFIX-drdrill-"* ]] || die "refusing to delete unexpected identifier $drill"
    read -r -p "Delete the DR drill instance $drill now? (yes/no) " ans
    if [ "$ans" = yes ]; then
      aws rds delete-db-instance --region "$DR_REGION" --db-instance-identifier "$drill" --skip-final-snapshot >/dev/null && info "deleting $drill"
    else info "remember: aws rds delete-db-instance --region $DR_REGION --db-instance-identifier $drill --skip-final-snapshot"; fi
    [ "$ok" = yes ] && info "DR DRILL PASSED (record: restore $mins min, latest restorable time $latest)" || die "DR DRILL FAILED"
    ;;
  outputs)
    need_aws
    aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
    ;;
  destroy)
    die "production has no destroy command (deletion and termination protection are on). See docs/OPERATIONS.md."
    ;;
  *)
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
