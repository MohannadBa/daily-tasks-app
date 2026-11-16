#!/bin/bash
# Runs inside LocalStack once it is ready. Creates the private bucket and SQS queues (with DLQ).
set -euo pipefail

BUCKET="${S3_BUCKET:-dailytasks-attachments}"
QUEUE="${SQS_QUEUE_NAME:-dailytasks-events}"

awslocal s3api create-bucket --bucket "$BUCKET" >/dev/null 2>&1 || true
awslocal s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
# Browsers upload directly with pre-signed PUT URLs, so the bucket needs CORS (objects stay private).
awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:3001", "http://127.0.0.1:3001", "http://localhost:8081"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}'

DLQ_URL=$(awslocal sqs create-queue --queue-name "${QUEUE}-dlq" --attributes MessageRetentionPeriod=1209600 --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sqs create-queue --queue-name "$QUEUE" --attributes "{
  \"VisibilityTimeout\": \"60\",
  \"ReceiveMessageWaitTimeSeconds\": \"20\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
}" >/dev/null

echo "LocalStack resources ready: s3://$BUCKET, sqs:$QUEUE (+dlq)"
