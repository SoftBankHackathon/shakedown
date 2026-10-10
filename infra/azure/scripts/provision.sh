#!/usr/bin/env bash
# Azure 전용 인프라를 처음 한 번 만들고 어댑터 설정 파일(.data/azure/config.json)을 만든다. 비용이 발생한다.
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/provision.sh what-if   # 바뀔 내용만 확인
#   AZURE_SUBSCRIPTION_ID=<구독 ID> bash infra/azure/scripts/provision.sh           # 실제 생성
# 스택 하나에 DB 엔진 하나다 (AWS와 같은 원칙). 다른 엔진은 AZURE_DATABASE_ENGINE=mysql|mongodb로 새 리소스 그룹에 만든다:
#   AZURE_DATABASE_ENGINE=mysql AZURE_RESOURCE_GROUP=rg-shakedown-mysql AZURE_CONFIG=.data/azure/mysql.json bash infra/azure/scripts/provision.sh
# 이미 만든 단계는 건너뛴다: 다시 돌려도 DB 비밀번호와 어댑터가 배포한 앱이 바뀌지 않는다.
set -euo pipefail

: "${AZURE_SUBSCRIPTION_ID:?해커톤 구독 ID를 AZURE_SUBSCRIPTION_ID에 지정하세요}"
MODE="${1:-create}"
ENGINE="${AZURE_DATABASE_ENGINE:-postgres}"
case "$ENGINE" in
  postgres) DB_NAMESPACE=Microsoft.DBforPostgreSQL ;;
  mysql) DB_NAMESPACE=Microsoft.DBforMySQL ;;
  mongodb) DB_NAMESPACE=Microsoft.DocumentDB ;;
  *) echo "AZURE_DATABASE_ENGINE은 postgres|mysql|mongodb 중 하나여야 합니다: $ENGINE" >&2; exit 1 ;;
esac
RG="${AZURE_RESOURCE_GROUP:-rg-shakedown-board}"
PROJECT_ID="${AZURE_PROJECT_ID:-prj_board}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/.data/azure"
CONFIG="${AZURE_CONFIG:-$OUT/config.json}"

# 회사 계정 등 다른 구독으로 로그인돼 있으면 아무것도 만들지 않는다.
read -r current TENANT_ID < <(az account show --query "[id, tenantId]" -o tsv | paste - -)
if [ "$current" != "$AZURE_SUBSCRIPTION_ID" ]; then
  echo "현재 az 구독($current)이 AZURE_SUBSCRIPTION_ID와 다릅니다. az account set으로 바꾼 뒤 다시 실행하세요." >&2
  exit 1
fi

NAMESPACES="Microsoft.App Microsoft.OperationalInsights Microsoft.KeyVault Microsoft.ContainerRegistry Microsoft.Network Microsoft.ManagedIdentity $DB_NAMESPACE"
registered="$(az provider list --query "[?registrationState=='Registered'].namespace" -o tsv)"
for ns in $NAMESPACES; do
  grep -qx "$ns" <<<"$registered" || { echo "서비스 등록: $ns"; az provider register -n "$ns" --wait; }
done

az group create -n "$RG" -l koreacentral -o none

# 비밀번호는 파일·명령줄에 남기지 않는다: 권한 600 임시 파라미터 파일로만 넘기고 끝나면 지운다.
infra_params() {
  params="$(mktemp)"; chmod 600 "$params"; trap 'rm -f "$params"' EXIT
  printf '{"dbPassword":{"value":"%sAa1"},"databaseEngine":{"value":"%s"}}' "$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 28)" "$ENGINE" > "$params"
}

if [ "$MODE" = what-if ]; then
  infra_params
  az deployment group what-if -g "$RG" -f "$HERE/bicep/main.bicep" -p "@$params"
  exit 0
fi

succeeded() { [ "$(az deployment group show -g "$RG" -n "$1" --query properties.provisioningState -o tsv 2>/dev/null)" = Succeeded ]; }

if succeeded sd-infra; then
  # 같은 리소스 그룹을 다른 엔진으로 다시 돌리면 DB를 바꾸지 않고 멈춘다 (데이터 이전 없음).
  existing="$(az deployment group show -g "$RG" -n sd-infra --query "properties.parameters.databaseEngine.value" -o tsv)"
  [ "${existing:-postgres}" = "$ENGINE" ] || { echo "리소스 그룹 $RG의 DB 엔진은 ${existing:-postgres}입니다. $ENGINE 스택은 다른 AZURE_RESOURCE_GROUP에 만드세요." >&2; exit 1; }
  echo "기반 인프라가 이미 있어 건너뜁니다."
else
  echo "기반 인프라 생성 ($ENGINE, 20분 안팎)"
  infra_params
  az deployment group create -g "$RG" -n sd-infra -f "$HERE/bicep/main.bicep" -p "@$params" -o none
  rm -f "$params"
  # Key Vault·ACR 역할 부여가 퍼지기 전에 앱을 만들면 비밀값을 못 읽어 실패할 수 있다.
  echo "역할 부여 반영 대기 (90초)"; sleep 90
fi
infra="$(az deployment group show -g "$RG" -n sd-infra --query properties.outputs -o json)"
# 이전 템플릿으로 만든 스택에는 없는 출력(dbUrlSecretUri 등)은 빈 값으로 둔다.
out() { python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2], {}).get("value", ""))' "$1" "$2"; }

if succeeded sd-app; then
  echo "Container App이 이미 있어 건너뜁니다 (어댑터가 배포한 이미지 유지)."
else
  echo "Container App, 초기화 작업 생성"
  az deployment group create -g "$RG" -n sd-app -f "$HERE/bicep/app.bicep" -o none -p \
    environmentName="$(out "$infra" environmentName)" identityName="$(out "$infra" identityName)" \
    registryServer="$(out "$infra" registryServer)" databaseEngine="$ENGINE" dbHost="$(out "$infra" dbHost)" dbName="$(out "$infra" dbName)" \
    dbUsername="$(out "$infra" dbUsername)" dbPasswordSecretUri="$(out "$infra" dbPasswordSecretUri)"
fi
app="$(az deployment group show -g "$RG" -n sd-app --query properties.outputs -o json)"

# runtime.init_command용 작업. 앱과 따로 만들어서 이미 운영 중인 스택에도 앱을 건드리지 않고 추가된다.
if ! succeeded sd-init; then
  echo "초기화 작업(sd-init) 생성"
  az deployment group create -g "$RG" -n sd-init -f "$HERE/bicep/init.bicep" -o none -p \
    environmentName="$(out "$infra" environmentName)" identityName="$(out "$infra" identityName)" \
    registryServer="$(out "$infra" registryServer)" dbPasswordSecretUri="$(out "$infra" dbPasswordSecretUri)"
fi
init="$(az deployment group show -g "$RG" -n sd-init --query properties.outputs -o json)"

mkdir -p "$OUT"; chmod 700 "$OUT"
# 배포 출력으로 설정을 만들고 어댑터와 같은 스키마(src/config.ts)로 검증해 바로 쓴다. 비밀값은 없다 (Key Vault 주소만).
# 이전 템플릿으로 만든 스택에 없는 출력(dbUrlSecretUri 등)은 빠지고, 필수 항목이 없으면 여기서 실패한다.
(cd "$ROOT" && SUBSCRIPTION="$AZURE_SUBSCRIPTION_ID" TENANT="$TENANT_ID" RG="$RG" PROJECT="$PROJECT_ID" ENGINE="$ENGINE" \
  node --import tsx --input-type=module -e '
import { writeFileSync } from "node:fs";
import { configSchema } from "./infra/azure/src/config.ts";
const [path, ...outputs] = process.argv.slice(1);
const [infra, app, init] = outputs.map(o => JSON.parse(o));
const v = (o, k) => o[k]?.value || undefined, e = process.env;
const config = configSchema.parse({
  subscriptionId: e.SUBSCRIPTION, tenantId: e.TENANT, resourceGroup: e.RG, projectId: e.PROJECT,
  containerApp: v(app, "containerApp"), initJob: v(init, "initJob"),
  repositoryUri: `${v(infra, "registryServer")}/shakedown-board`, publicUrl: v(app, "publicUrl"),
  dbEngine: e.ENGINE, dbHost: v(infra, "dbHost"), dbName: v(infra, "dbName"), dbUsername: v(infra, "dbUsername"),
  dbPasswordSecretUri: v(infra, "dbPasswordSecretUri"), dbUrlSecretUri: v(infra, "dbUrlSecretUri"), port: 8080,
});
writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
' "$CONFIG" "$infra" "$app" "$init")
echo "완료: $CONFIG"
# 기존 Spring 샘플용 스키마 초기화 작업(sd-schema-init)은 PostgreSQL 스택에만 있다. 다른 엔진은 runtime.init_command(sd-init)를 쓴다.
case "$ENGINE" in
  postgres) echo "다음: IMAGE=\$(AZURE_ADAPTER_CONFIG=$CONFIG bash infra/azure/scripts/publish-image.sh) && AZURE_ADAPTER_CONFIG=$CONFIG bash infra/azure/scripts/schema-init.sh \"\$IMAGE\"" ;;
  *) echo "다음: AZURE_ADAPTER_CONFIG=$CONFIG npm run dev:azure (마이그레이션은 runtime.init_command로 실행)" ;;
esac
