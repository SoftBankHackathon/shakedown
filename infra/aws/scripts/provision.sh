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
database_engine="${HACKATHON_DATABASE_ENGINE:-postgres}"
case "$database_engine" in postgres|mysql|mongodb) ;; *) echo 'Invalid database engine' >&2; exit 1;; esac
postgres_version="${HACKATHON_POSTGRES_VERSION:-17.1}"
mysql_version="${HACKATHON_MYSQL_VERSION:-8.4.7}"
# Never replace an existing database with another engine through this helper.
lookup_error=$(mktemp)
template_file=$(mktemp)
trap 'rm -f "$lookup_error" "$template_file"' EXIT
node "$(dirname "$0")/compact-template.mjs" "$template_file"
if ! existing=$(aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 cloudformation describe-stacks --stack-name "$HACKATHON_STACK" --query 'Stacks[0].Parameters[?ParameterKey==`DatabaseEngine`].ParameterValue | [0]' --output text 2>"$lookup_error"); then
  if [[ "$(cat "$lookup_error")" == *"does not exist"* ]]; then existing=''; else cat "$lookup_error" >&2; exit 1; fi
fi
if [[ -n "$existing" && "$existing" != None && "$existing" != "$database_engine" ]]; then echo 'Use a new stack for a different database engine; no automatic data migration' >&2; exit 1; fi
if [[ "$existing" == None && "$database_engine" != postgres ]]; then echo 'Legacy PostgreSQL stack: create a new stack for another engine' >&2; exit 1; fi
if [[ "$create_database" == true && "$database_engine" != mongodb ]]; then
  if [[ "$database_engine" == mysql ]]; then
    : "${HACKATHON_MYSQL_VERSION:?Choose an available RDS MySQL 8.4 version}"
    engine_version="$mysql_version"
  else
    : "${HACKATHON_POSTGRES_VERSION:?Choose an available RDS PostgreSQL 17 version}"
    engine_version="$postgres_version"
  fi
  available=$(aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 rds describe-orderable-db-instance-options --engine "$database_engine" --engine-version "$engine_version" --db-instance-class db.t3.micro --query 'length(OrderableDBInstanceOptions)' --output text)
  [[ "$available" -gt 0 ]] || { echo 'Chosen RDS version/db.t3.micro unavailable in Seoul' >&2; exit 1; }
fi
# Omit unset optional parameters so existing stack grants are preserved.
extra_parameters=("DatabaseEngine=$database_engine" "MysqlVersion=$mysql_version" "Name=$HACKATHON_STACK" "PostgresVersion=$postgres_version" "CreateDatabase=$create_database" "AppPort=${HACKATHON_APP_PORT:-8080}")
if [[ ${HACKATHON_MONGO_SNAPSHOTS+x} ]]; then extra_parameters+=("EnableMongoSnapshots=$HACKATHON_MONGO_SNAPSHOTS"); fi
if [[ ${HACKATHON_DATABASE_NAME+x} ]]; then extra_parameters+=("DatabaseName=$HACKATHON_DATABASE_NAME"); fi
if [[ ${HACKATHON_ADDITIONAL_SECRET_ARNS+x} ]]; then extra_parameters+=("AdditionalSecretArns=$HACKATHON_ADDITIONAL_SECRET_ARNS"); fi
if [[ ${HACKATHON_ADDITIONAL_SECRET_KMS_KEY_ARNS+x} ]]; then extra_parameters+=("AdditionalSecretKmsKeyArns=$HACKATHON_ADDITIONAL_SECRET_KMS_KEY_ARNS"); fi
aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 cloudformation deploy \
  --stack-name "$HACKATHON_STACK" --template-file "$template_file" \
  --parameter-overrides "${extra_parameters[@]}" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset
aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2 cloudformation describe-stacks \
  --stack-name "$HACKATHON_STACK" --query 'Stacks[0].Outputs' --output json
