#!/usr/bin/env bash
set -euo pipefail
# Explicit user-operated provisioning; never invoked by adapter startup/tests.
: "${HACKATHON_PROVISION_PROFILE:?Choose the provisioning profile}"
: "${HACKATHON_ACCOUNT_ID:?Set the expected 12-digit hackathon account ID}"
: "${HACKATHON_STACK:?Set a new dedicated stack name, e.g. shakedown-board}"
if [[ "$HACKATHON_PROVISION_PROFILE" == default ]]; then
  echo 'Use a named hackathon profile, not default.' >&2; exit 1
fi
actual=$(aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 sts get-caller-identity --query Account --output text)
[[ "$actual" == "$HACKATHON_ACCOUNT_ID" ]] || { echo 'Account mismatch' >&2; exit 1; }
create_database="${HACKATHON_CREATE_DATABASE:-true}"
[[ "$create_database" == true || "$create_database" == false ]] || { echo 'HACKATHON_CREATE_DATABASE must be true or false' >&2; exit 1; }
postgres_version="${HACKATHON_POSTGRES_VERSION:-17.1}"
if [[ "$create_database" == true ]]; then
  : "${HACKATHON_POSTGRES_VERSION:?Choose an available RDS PostgreSQL 17 minor version}"
  available=$(aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 rds describe-orderable-db-instance-options --engine postgres --engine-version "$postgres_version" --db-instance-class db.t3.micro --query 'length(OrderableDBInstanceOptions)' --output text)
  [[ "$available" -gt 0 ]] || { echo 'Chosen PostgreSQL version/db.t3.micro is unavailable in Seoul' >&2; exit 1; }
fi
aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 cloudformation deploy \
  --stack-name "$HACKATHON_STACK" --template-file "$(dirname "$0")/../cloudformation/foundation.yaml" \
  --parameter-overrides "Name=$HACKATHON_STACK" "PostgresVersion=$postgres_version" "CreateDatabase=$create_database" "AppPort=${HACKATHON_APP_PORT:-8080}" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 cloudformation describe-stacks \
  --stack-name "$HACKATHON_STACK" --query 'Stacks[0].Outputs' --output json
