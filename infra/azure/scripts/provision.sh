#!/usr/bin/env bash
# Azure 전용 인프라를 처음 한 번 만들고 어댑터 설정 파일(.data/azure/config.json)을 만든다. 비용이 발생한다.
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/provision.sh what-if   # 바뀔 내용만 확인
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/provision.sh           # 실제 생성
# 이미 만든 단계는 건너뛴다: 다시 돌려도 DB 비밀번호와 어댑터가 배포한 앱이 바뀌지 않는다.
set -euo pipefail

: "${AZURE_SUBSCRIPTION_ID:?해커톤 구독 ID를 AZURE_SUBSCRIPTION_ID에 지정하세요}"
MODE="${1:-create}"
RG="${AZURE_RESOURCE_GROUP:-rg-shakedown-board}"
PROJECT_ID="${AZURE_PROJECT_ID:-prj_board}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/.data/azure"

# 회사 계정 등 다른 구독으로 로그인돼 있으면 아무것도 만들지 않는다.
read -r current TENANT_ID < <(az account show --query "[id, tenantId]" -o tsv | paste - -)
if [ "$current" != "$AZURE_SUBSCRIPTION_ID" ]; then
  echo "현재 az 구독($current)이 AZURE_SUBSCRIPTION_ID와 다릅니다. az account set으로 바꾼 뒤 다시 실행하세요." >&2
  exit 1
fi

NAMESPACES="Microsoft.App Microsoft.OperationalInsights Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ContainerRegistry Microsoft.Network Microsoft.ManagedIdentity"
registered="$(az provider list --query "[?registrationState=='Registered'].namespace" -o tsv)"
for ns in $NAMESPACES; do
  grep -qx "$ns" <<<"$registered" || { echo "서비스 등록: $ns"; az provider register -n "$ns" --wait; }
done

az group create -n "$RG" -l koreacentral -o none

# 비밀번호는 파일·명령줄에 남기지 않는다: 권한 600 임시 파라미터 파일로만 넘기고 끝나면 지운다.
infra_params() {
  params="$(mktemp)"; chmod 600 "$params"; trap 'rm -f "$params"' EXIT
  printf '{"dbPassword":{"value":"%sAa1"}}' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 28)" > "$params"
}

if [ "$MODE" = what-if ]; then
  infra_params
  az deployment group what-if -g "$RG" -f "$HERE/bicep/main.bicep" -p "@$params"
  exit 0
fi

succeeded() { [ "$(az deployment group show -g "$RG" -n "$1" --query properties.provisioningState -o tsv 2>/dev/null)" = Succeeded ]; }

if succeeded sd-infra; then
  echo "기반 인프라가 이미 있어 건너뜁니다."
else
  echo "기반 인프라 생성 (20분 안팎)"
  infra_params
  az deployment group create -g "$RG" -n sd-infra -f "$HERE/bicep/main.bicep" -p "@$params" -o none
  rm -f "$params"
  # Key Vault·ACR 역할 부여가 퍼지기 전에 앱을 만들면 비밀값을 못 읽어 실패할 수 있다.
  echo "역할 부여 반영 대기 (90초)"; sleep 90
fi
infra="$(az deployment group show -g "$RG" -n sd-infra --query properties.outputs -o json)"
out() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]]["value"])' "$1" "$2"; }

if succeeded sd-app; then
  echo "Container App이 이미 있어 건너뜁니다 (어댑터가 배포한 이미지 유지)."
else
  echo "Container App, 스키마 초기화 작업 생성"
  az deployment group create -g "$RG" -n sd-app -f "$HERE/bicep/app.bicep" -o none -p \
    environmentName="$(out "$infra" environmentName)" identityName="$(out "$infra" identityName)" \
    registryServer="$(out "$infra" registryServer)" dbHost="$(out "$infra" dbHost)" dbName="$(out "$infra" dbName)" \
    dbUsername="$(out "$infra" dbUsername)" dbPasswordSecretUri="$(out "$infra" dbPasswordSecretUri)"
fi
app="$(az deployment group show -g "$RG" -n sd-app --query properties.outputs -o json)"

mkdir -p "$OUT"; chmod 700 "$OUT"
# 이름은 src/config.ts configSchema와 같다. 비밀값은 없다.
cat > "$OUT/config.json" <<JSON
{
  "subscriptionId": "$AZURE_SUBSCRIPTION_ID",
  "tenantId": "$TENANT_ID",
  "resourceGroup": "$RG",
  "projectId": "$PROJECT_ID",
  "containerApp": "$(out "$app" containerApp)",
  "repositoryUri": "$(out "$infra" registryServer)/shakedown-board",
  "publicUrl": "$(out "$app" publicUrl)",
  "dbHost": "$(out "$infra" dbHost)",
  "dbName": "$(out "$infra" dbName)",
  "dbUsername": "$(out "$infra" dbUsername)",
  "dbPasswordSecretUri": "$(out "$infra" dbPasswordSecretUri)",
  "port": 8080
}
JSON
# 어댑터가 읽는 것과 같은 스키마로 바로 검증한다.
(cd "$ROOT" && node --import tsx --input-type=module -e \
  "import { loadConfig } from './infra/azure/src/config.ts'; loadConfig(process.argv[1]);" "$OUT/config.json")
echo "완료: $OUT/config.json"
echo "다음: IMAGE=\$(bash infra/azure/scripts/publish-image.sh) && bash infra/azure/scripts/schema-init.sh \"\$IMAGE\""
