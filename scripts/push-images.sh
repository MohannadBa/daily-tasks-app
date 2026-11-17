#!/usr/bin/env bash
# Builds the api, worker and web images and pushes them to ECR with an immutable tag.
# Usage: AWS_REGION=me-central-1 AWS_ACCOUNT_ID=123456789012 scripts/push-images.sh [tag]
# Requires the DailyTasks-Registry stack to be deployed first. Pushing images costs a little ECR storage.
set -euo pipefail

TAG="${1:-$(git rev-parse --short HEAD)}"
: "${AWS_REGION:?set AWS_REGION}"
: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for svc in api worker web; do
  image="${REGISTRY}/dailytasks/${svc}:${TAG}"
  echo "==> building ${image}"
  docker build --platform linux/amd64 -f "docker/${svc}/Dockerfile" -t "$image" .
  docker push "$image"
done

echo "Pushed tag ${TAG}. Deploy with: pnpm --filter @dailytasks/aws-cdk exec cdk deploy DailyTasks-staging -c imageTag=${TAG}"
