#!/usr/bin/env bash
# Terraform으로 AWS 기반 스택을 만들고 어댑터 설정 파일을 쓴다 (provision.sh + config-from-outputs.ts와 같은 일, docs/terraform-migration-aws-gcp.md 1절). 비용이 발생한다.
# 환경변수 이름은 provision.sh와 같다 (외부 비밀 HACKATHON_ADDITIONAL_SECRET_ARNS는 이름이 필요해 terraform -var 'additional_secrets={...}'로 넘긴다):
#   HACKATHON_PROVISION_PROFILE=<named profile> HACKATHON_ACCOUNT_ID=<12자리> HACKATHON_STACK=shakedown-tf \
#   HACKATHON_POSTGRES_VERSION=17.x bash infra/aws/scripts/terraform.sh plan|apply|destroy|output
# 선택: HACKATHON_DATABASE_ENGINE=postgres|mysql|mongodb, HACKATHON_MYSQL_VERSION, HACKATHON_CREATE_DATABASE=true|false, HACKATHON_MONGO_SNAPSHOTS=true|false,
#       HACKATHON_AUTO_APPROVE=1(확인 없이 적용), HACKATHON_ALLOW_DATA_LOSS=1(DB 삭제·교체가 든 계획도 적용),
#       HACKATHON_APP_PORT, HACKATHON_DATABASE_NAME, HACKATHON_PROJECT_ID(기본 prj_board), HACKATHON_HTTPS_CONTROL_URL
# 그 밖의 terraform 인자는 뒤에 그대로 넘긴다 (예: -var skip_final_snapshot=true).
set -euo pipefail

: "${HACKATHON_PROVISION_PROFILE:?Choose the provisioning profile}"
: "${HACKATHON_ACCOUNT_ID:?Set the expected 12-digit hackathon account ID}"
: "${HACKATHON_STACK:?Set a dedicated stack name, e.g. shakedown-tf}"
COMMAND="${1:-plan}"
case "$COMMAND" in plan|apply|destroy|output) ;; *) echo "사용법: terraform.sh plan|apply|destroy|output" >&2; exit 1 ;; esac
[ "$HACKATHON_PROVISION_PROFILE" != default ] || { echo 'Use a named hackathon profile, not default.' >&2; exit 1; }
ENGINE="${HACKATHON_DATABASE_ENGINE:-postgres}"
CREATE_DB="${HACKATHON_CREATE_DATABASE:-true}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TF="$ROOT/infra/aws/terraform"
CONFIG="${AWS_ADAPTER_CONFIG:-$ROOT/.data/aws/$HACKATHON_STACK.json}"
AWS=(aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2)

# 다른 계정에 만드는 사고를 막는다 (provider의 allowed_account_ids가 한 번 더 막는다).
actual=$("${AWS[@]}" sts get-caller-identity --query Account --output text)
[ "$actual" = "$HACKATHON_ACCOUNT_ID" ] || { echo 'Account mismatch' >&2; exit 1; }

# 같은 이름으로 CloudFormation 스택이 있으면 ECR·로그 그룹 이름이 겹친다. 별도 이름을 쓰게 한다.
if "${AWS[@]}" cloudformation describe-stacks --stack-name "$HACKATHON_STACK" >/dev/null 2>&1; then
  echo "CloudFormation 스택 $HACKATHON_STACK이 이미 있습니다. Terraform 스택은 다른 이름(예: shakedown-tf)을 쓰세요." >&2; exit 1
fi

# 상태 파일에는 DB 비밀번호가 들어간다. Git 밖(.data, gitignore)에 소유자만 읽게 둔다.
mkdir -p "$ROOT/.data/aws/terraform"; chmod 700 "$ROOT/.data/aws" "$ROOT/.data/aws/terraform"
terraform -chdir="$TF" init -input=false >/dev/null
terraform -chdir="$TF" workspace select -or-create "$HACKATHON_STACK" >/dev/null
[ "$COMMAND" = output ] && exec terraform -chdir="$TF" output -json adapter_config

# 어댑터가 만든 ECS 서비스가 남아 있으면 클러스터·TG 삭제가 실패한다. 먼저 어댑터 DELETE로 내리게 한다.
if [ "$COMMAND" = destroy ]; then
  status="$("${AWS[@]}" ecs describe-services --cluster "$HACKATHON_STACK" --services "$HACKATHON_STACK" --query 'services[0].status' --output text 2>/dev/null || true)"
  if [ "$status" = ACTIVE ] || [ "$status" = DRAINING ]; then
    echo "ECS 서비스 $HACKATHON_STACK이 남아 있습니다($status). 어댑터 DELETE로 먼저 내리세요." >&2; exit 1
  fi
fi

# 기본값은 variables.tf 한 곳에 두고, 지정한 값만 넘긴다.
args=(-var profile="$HACKATHON_PROVISION_PROFILE" -var account_id="$HACKATHON_ACCOUNT_ID" -var name="$HACKATHON_STACK"
  -var database_engine="$ENGINE" -var create_database="$CREATE_DB" -var config_path="$CONFIG")
[ -n "${HACKATHON_APP_PORT:-}" ] && args+=(-var app_port="$HACKATHON_APP_PORT")
[ -n "${HACKATHON_MYSQL_VERSION:-}" ] && args+=(-var mysql_version="$HACKATHON_MYSQL_VERSION")
[ -n "${HACKATHON_DATABASE_NAME:-}" ] && args+=(-var db_name="$HACKATHON_DATABASE_NAME")
[ -n "${HACKATHON_PROJECT_ID:-}" ] && args+=(-var project_id="$HACKATHON_PROJECT_ID")
[ -n "${HACKATHON_POSTGRES_VERSION:-}" ] && args+=(-var postgres_version="$HACKATHON_POSTGRES_VERSION")
[ -n "${HACKATHON_MONGO_SNAPSHOTS:-}" ] && args+=(-var enable_mongo_snapshots="$HACKATHON_MONGO_SNAPSHOTS")
[ -n "${HACKATHON_HTTPS_CONTROL_URL:-}" ] && args+=(-var https_control_url="$HACKATHON_HTTPS_CONTROL_URL")

if [ "$COMMAND" != apply ]; then
  terraform -chdir="$TF" "$COMMAND" -input=false "${args[@]}" "${@:2}"
else
  # 엔진·DB 이름·AZ 변경 등 어떤 이유로든 DB가 지워지거나 교체되는 계획이면 멈춘다 (데이터 이전 없음, provision.sh의 엔진 가드를 일반화).
  # 계획 파일에는 비밀값이 들어가므로 .data(700)에 두고 끝나면 지운다.
  PLAN="$ROOT/.data/aws/terraform/$HACKATHON_STACK.tfplan"
  trap 'rm -f "$PLAN"' EXIT
  terraform -chdir="$TF" plan -input=false -out="$PLAN" "${args[@]}" "${@:2}"
  doomed="$(terraform -chdir="$TF" show -json "$PLAN" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const stateful = ["aws_db_instance", "aws_ebs_volume", "aws_instance"];
      for (const r of JSON.parse(s).resource_changes ?? [])
        if (stateful.includes(r.type) && r.change.actions.includes("delete")) console.log(r.address);
    });')"
  if [ -n "$doomed" ] && [ -z "${HACKATHON_ALLOW_DATA_LOSS:-}" ]; then
    printf '이 계획은 DB 자원을 지우거나 교체합니다 (데이터 이전 없음):\n%s\n다른 엔진·이름이면 새 스택 이름을 쓰세요. 정말 지우려면 HACKATHON_ALLOW_DATA_LOSS=1.\n' "$doomed" >&2
    exit 1
  fi
  if [ -z "${HACKATHON_AUTO_APPROVE:-}" ]; then
    read -r -p "위 계획을 적용할까요? (yes 입력): " ok
    [ "$ok" = yes ] || { echo '취소했습니다.' >&2; exit 1; }
  fi
  terraform -chdir="$TF" apply -input=false "$PLAN"

  # CFN WaitCondition 대신: Mongo 노드0이 3멤버 TLS 복제 세트를 확인하고 DbUrlSecret에 mongodb:// URL을 쓸 때까지 기다린다 (최대 30분).
  # 준비 전에 배포해도 어댑터가 URL을 검증해 실패하므로 안전하지만, 데모 전에 여기서 끝까지 기다린다.
  if [ "$ENGINE" = mongodb ] && [ "$CREATE_DB" = true ]; then
    url_secret="$(terraform -chdir="$TF" output -raw db_url_secret_arn)"
    echo "MongoDB 복제 세트 준비를 기다립니다 (최대 30분)..."
    for i in $(seq 1 180); do
      # 값은 화면에 내지 않고 접두어만 비교한다.
      if "${AWS[@]}" secretsmanager get-secret-value --secret-id "$url_secret" --query SecretString --output text 2>/dev/null | grep -q '^mongodb://'; then
        echo "MongoDB 준비 완료 ($((i * 10))초 이내)"; break
      fi
      [ "$i" = 180 ] && { echo "30분 안에 준비되지 않았습니다. EC2의 /var/log/cloud-init-output.log를 SSM으로 확인하세요." >&2; exit 1; }
      sleep 10
    done
  fi
  # 어댑터가 읽는 것과 같은 스키마로 바로 검증한다.
  (cd "$ROOT" && node --import tsx --input-type=module -e \
    "import { loadConfig } from './infra/aws/src/config.ts'; loadConfig(process.argv[1]);" "$CONFIG")
  echo "완료: $CONFIG"
  echo "다음: 어댑터 principal에 정책을 붙인다 → terraform -chdir=infra/aws/terraform output adapter_policy_arn / image_publisher_policy_arn"
  echo "      스키마 초기화는 기존과 같다 (README의 npm run bootstrap)."
fi
