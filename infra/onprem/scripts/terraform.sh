#!/usr/bin/env bash
# 온프레미스 호스트(AWS EC2로 흉내)를 Terraform으로 만든다 (docs/terraform-migration-aws-gcp.md 3절). 비용이 발생한다.
#   HACKATHON_PROVISION_PROFILE=<profile> HACKATHON_ACCOUNT_ID=<12자리> bash infra/onprem/scripts/terraform.sh plan|apply|destroy|output
#   ... terraform.sh check    # 서버 설치가 끝났고 로컬 어댑터(127.0.0.1:9101)가 살아 있는지 SSM으로 확인
#   ... terraform.sh update   # 현재 커밋의 infra/local을 다시 올리고 서버에서 교체 후 재시작 (서버·DB 볼륨은 그대로)
# 선택: ONPREM_NAME(기본 shakedown-onprem), ONPREM_ALLOWED_CIDRS="203.0.113.7/32,..."(앱 포트 허용 IP), ONPREM_APP_PORT(기본 18080),
#       ONPREM_ECR_REPOSITORY_ARNS="arn:aws:ecr:...,..."(서버가 ECR에서 pull, 명세 3.4 b안)
set -euo pipefail

: "${HACKATHON_PROVISION_PROFILE:?Choose the provisioning profile}"
: "${HACKATHON_ACCOUNT_ID:?Set the expected 12-digit hackathon account ID}"
COMMAND="${1:-plan}"
case "$COMMAND" in plan|apply|destroy|output|check|update) ;; *) echo "사용법: terraform.sh plan|apply|destroy|output|check|update" >&2; exit 1 ;; esac
[ "$HACKATHON_PROVISION_PROFILE" != default ] || { echo 'Use a named hackathon profile, not default.' >&2; exit 1; }
NAME="${ONPREM_NAME:-shakedown-onprem}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TF="$ROOT/infra/onprem/terraform"
DATA="$ROOT/.data/onprem"
BUNDLE="$DATA/$NAME-bundle.tar.gz"
ENGINE_ENV="$DATA/$NAME-engine.env"
AWS=(aws --profile "$HACKATHON_PROVISION_PROFILE" --region ap-northeast-2)

actual=$("${AWS[@]}" sts get-caller-identity --query Account --output text)
[ "$actual" = "$HACKATHON_ACCOUNT_ID" ] || { echo 'Account mismatch' >&2; exit 1; }

mkdir -p "$DATA/terraform"; chmod 700 "$DATA" "$DATA/terraform"
terraform -chdir="$TF" init -input=false >/dev/null
terraform -chdir="$TF" workspace select -or-create "$NAME" >/dev/null
[ "$COMMAND" = output ] && exec terraform -chdir="$TF" output

# 서버에서 명령 하나를 SSM으로 돌리고 결과를 기다린다.
run_remote() {
  local instance cmd_id result
  instance="$(terraform -chdir="$TF" output -raw instance_id)"
  cmd_id="$("${AWS[@]}" ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
    --parameters "commands=[\"$1\"]" --query Command.CommandId --output text)"
  for _ in $(seq 1 150); do
    sleep 2
    result="$("${AWS[@]}" ssm get-command-invocation --command-id "$cmd_id" --instance-id "$instance" \
      --query '[Status,StandardOutputContent,StandardErrorContent]' --output text 2>/dev/null || true)"
    case "$result" in Success*) printf '%s\n' "${result#Success}"; return 0 ;;
      Failed*|Cancelled*|TimedOut*) printf '%s\n' "$result" >&2; return 1 ;; esac
  done
  echo "SSM 명령이 5분 안에 끝나지 않았습니다 ($cmd_id)." >&2; return 1
}

if [ "$COMMAND" = check ]; then
  run_remote "test -f /var/lib/shakedown-local/.bootstrap-done && curl -fsS http://127.0.0.1:9101/health && systemctl is-enabled shakedown-local docker"
  echo "공개 주소: $(terraform -chdir="$TF" output -raw public_url)"
  exit 0
fi

# 코드 묶음: 레포가 private일 수 있어 서버에서 clone하지 않는다. 로컬 어댑터가 쓰는 두 폴더만, 커밋된 내용만 담는다.
# destroy에도 만든다 (filemd5가 계산된다). 같은 HEAD면 결과가 같아 S3에 다시 올라가지 않는다.
PARTS=(infra/local packages/contracts)
if [ -n "$(git -C "$ROOT" status --porcelain -- "${PARTS[@]}")" ]; then
  echo "경고: ${PARTS[*]}에 커밋하지 않은 변경이 있습니다. 묶음에는 커밋된 HEAD만 들어갑니다." >&2
fi
git -C "$ROOT" archive --format=tar.gz -o "$BUNDLE" HEAD "${PARTS[@]}"

hcl_list() { local IFS=,; local out=(); for v in $1; do [ -n "$v" ] && out+=("\"$v\""); done; echo "[${out[*]}]"; }
args=(-var profile="$HACKATHON_PROVISION_PROFILE" -var account_id="$HACKATHON_ACCOUNT_ID" -var name="$NAME"
  -var bundle_path="$BUNDLE" -var engine_env_path="$ENGINE_ENV"
  -var "allowed_cidrs=$(hcl_list "${ONPREM_ALLOWED_CIDRS:-}")" -var "ecr_repository_arns=$(hcl_list "${ONPREM_ECR_REPOSITORY_ARNS:-}")")
[ -n "${ONPREM_APP_PORT:-}" ] && args+=(-var app_port="$ONPREM_APP_PORT")  # 기본값은 variables.tf

if [ "$COMMAND" = update ]; then
  terraform -chdir="$TF" apply -input=false -auto-approve -target=aws_s3_object.bundle "${args[@]}"
  # 첫 부팅과 같은 설치 스크립트 (bootstrap.sh.tftpl이 만든다). 상태와 /etc/shakedown-local.env는 그대로 둔다.
  run_remote "/usr/local/sbin/shakedown-install-bundle"
  exit 0
fi

terraform -chdir="$TF" "$COMMAND" -input=false "${args[@]}" "${@:2}"

if [ "$COMMAND" = apply ]; then
  echo "완료. 서버 설치는 부팅 뒤 몇 분 걸린다 → bash infra/onprem/scripts/terraform.sh check"
  echo "코드 변경은 apply가 아니라 update로 서버에 반영한다 (서버는 부팅 때만 설치한다)."
  echo "엔진 설정: $ENGINE_ENV (LOCAL_DELIVERY_MODE·LOCAL_PUBLIC_URL)"
  echo "제어 API 연결: $(terraform -chdir="$TF" output -raw port_forward_command)"
fi
