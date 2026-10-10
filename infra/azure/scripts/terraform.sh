#!/usr/bin/env bash
# Terraform으로 Azure 스택을 만들고 어댑터 설정 파일을 쓴다 (provision.sh + Bicep을 대신함). 비용이 발생한다.
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/terraform.sh plan     # 바뀔 내용만 확인
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/terraform.sh apply    # 생성·갱신 → .data/azure/<리소스 그룹>.json
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/terraform.sh destroy  # 스택 전체 삭제
# 엔진·리소스 그룹: AZURE_DATABASE_ENGINE=postgres|mysql|mongodb, AZURE_RESOURCE_GROUP=rg-shakedown-... (스택마다 workspace 하나)
# 리전: AZURE_LOCATION (기본 koreacentral). 무료 체험 구독은 Container Apps 환경이 구독 전체에 1개라 스택을 하나만 둘 수 있다.
set -euo pipefail

: "${AZURE_SUBSCRIPTION_ID:?해커톤 구독 ID를 AZURE_SUBSCRIPTION_ID에 지정하세요}"
COMMAND="${1:-plan}"
case "$COMMAND" in plan|apply|destroy|output) ;; *) echo "사용법: terraform.sh plan|apply|destroy|output" >&2; exit 1 ;; esac
ENGINE="${AZURE_DATABASE_ENGINE:-postgres}"
RG="${AZURE_RESOURCE_GROUP:-rg-shakedown-tf-$ENGINE}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TF="$ROOT/infra/azure/terraform"
CONFIG="${AZURE_CONFIG:-$ROOT/.data/azure/$RG.json}"

# 상태 파일에는 DB 비밀번호가 들어간다. Git 밖(.data, gitignore)에 소유자만 읽게 둔다.
mkdir -p "$ROOT/.data/azure/terraform"; chmod 700 "$ROOT/.data/azure" "$ROOT/.data/azure/terraform"
terraform -chdir="$TF" init -input=false >/dev/null
terraform -chdir="$TF" workspace select -or-create "$RG" >/dev/null
[ "$COMMAND" = output ] && exec terraform -chdir="$TF" output -json adapter_config

# 회사 계정 등 다른 구독으로 로그인돼 있으면 아무것도 만들지 않는다 (provider는 az 로그인 정보를 쓴다).
current="$(az account show --query id -o tsv)"
if [ "$current" != "$AZURE_SUBSCRIPTION_ID" ]; then
  echo "현재 az 구독($current)이 AZURE_SUBSCRIPTION_ID와 다릅니다. az account set으로 바꾼 뒤 다시 실행하세요." >&2
  exit 1
fi

# 기본값은 variables.tf 한 곳에 두고, 지정한 값만 넘긴다.
args=(-var subscription_id="$AZURE_SUBSCRIPTION_ID" -var resource_group="$RG" -var database_engine="$ENGINE" -var config_path="$CONFIG")
[ -n "${AZURE_LOCATION:-}" ] && args+=(-var location="$AZURE_LOCATION")
[ -n "${AZURE_PROJECT_ID:-}" ] && args+=(-var project_id="$AZURE_PROJECT_ID")
terraform -chdir="$TF" "$COMMAND" -input=false "${args[@]}" "${@:2}"

if [ "$COMMAND" = apply ]; then
  # 어댑터가 읽는 것과 같은 스키마로 바로 검증한다.
  (cd "$ROOT" && node --import tsx --input-type=module -e \
    "import { loadConfig } from './infra/azure/src/config.ts'; loadConfig(process.argv[1]);" "$CONFIG")
  echo "완료: $CONFIG"
  case "$ENGINE" in
    postgres) echo "다음: IMAGE=\$(AZURE_ADAPTER_CONFIG=$CONFIG bash infra/azure/scripts/publish-image.sh) && AZURE_ADAPTER_CONFIG=$CONFIG bash infra/azure/scripts/schema-init.sh \"\$IMAGE\"" ;;
    *) echo "다음: AZURE_ADAPTER_CONFIG=$CONFIG npm run dev:azure (마이그레이션은 runtime.init_command로 실행)" ;;
  esac
fi
