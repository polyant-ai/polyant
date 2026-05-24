#!/bin/bash
set -euo pipefail

# Reads Aurora endpoint from CloudFormation outputs and initializes pgvector extension.
# Usage: source awsume test3-prod && ./scripts/db-init.sh

STAGE="${CDK_STAGE:-dev}"
STACK_NAME="agent-builder-${STAGE}"
REGION="${AWS_REGION:-eu-south-1}"

echo "Reading DB credentials from Secrets Manager..."
SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?contains(OutputKey,`DbSecret`)].OutputValue' \
  --output text --region "$REGION" 2>/dev/null || true)

if [ -z "$SECRET_ARN" ]; then
  # Fallback: find secret by name
  SECRET_ARN=$(aws secretsmanager list-secrets \
    --filter Key="name",Values="agent-builder-db-secrets-${STAGE}" \
    --query 'SecretList[0].ARN' --output text --region "$REGION")
fi

SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ARN" --region "$REGION" \
  --query 'SecretString' --output text)

DB_HOST=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")
DB_PORT=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")
DB_NAME=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dbname','agent_crm'))")
DB_USER=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
DB_PASS=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

echo "Connecting to ${DB_HOST}:${DB_PORT}/${DB_NAME} as ${DB_USER}..."
echo "Creating pgvector extension..."

PGPASSWORD="$DB_PASS" psql \
  "host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME} user=${DB_USER} sslmode=require" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "Done. pgvector extension created."
