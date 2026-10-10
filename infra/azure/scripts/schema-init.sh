#!/usr/bin/env bash
# 같은 digest 이미지로 스키마 초기화 작업을 한 번 실행한다 (AWS schema-init과 같은 역할).
# 앱은 DDL validate로만 뜨므로, 처음 준비할 때 앱 배포 전에 한 번 실행한다.
#   bash infra/azure/scripts/schema-init.sh <ACR image@sha256:digest>
set -euo pipefail

IMAGE="${1:?사용법: schema-init.sh <ACR image@sha256:digest>}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONFIG="${AZURE_ADAPTER_CONFIG:-$ROOT/.data/azure/config.json}"
read -r SUB RG REPO < <(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(c["subscriptionId"], c["resourceGroup"], c["repositoryUri"])' "$CONFIG")
[ "${IMAGE%@sha256:*}" = "$REPO" ] || { echo "설정한 ACR 저장소($REPO)의 이미지가 아닙니다: $IMAGE" >&2; exit 1; }
JOB=sd-schema-init

az containerapp job update -n "$JOB" -g "$RG" --image "$IMAGE" -o none
# az 2.91의 job start는 실행이 끝난 뒤에도 돌아오지 않아(10분 넘게) ARM start를 직접 부른다. 응답 본문에 실행 이름이 있다.
run="$(az rest --method post --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.App/jobs/$JOB/start?api-version=2024-03-01" --query name -o tsv)"
echo "실행: $run"
for _ in $(seq 1 120); do
  status="$(az containerapp job execution show -n "$JOB" -g "$RG" --job-execution-name "$run" --query properties.status -o tsv)"
  case "$status" in
    Succeeded) echo "스키마 초기화 완료"; exit 0 ;;
    Failed|Stopped|Degraded) echo "스키마 초기화 실패: $status. az containerapp job logs show -n $JOB -g $RG 로 확인하세요." >&2; exit 1 ;;
  esac
  sleep 5
done
echo "10분 안에 끝나지 않았습니다." >&2; exit 1
