#!/usr/bin/env bash
# Terraform으로 GCP 스택을 만들고 어댑터 설정 파일을 쓴다 (provision.sh와 같은 일, docs/terraform-migration-aws-gcp.md 2절). 비용이 발생한다.
#   GCP_PROJECT=<프로젝트 ID> bash infra/gcp/scripts/terraform.sh plan     # 바뀔 내용만 확인
#   GCP_PROJECT=<프로젝트 ID> bash infra/gcp/scripts/terraform.sh apply    # 생성·갱신 → .data/gcp/<workspace>.json
#   GCP_PROJECT=<프로젝트 ID> bash infra/gcp/scripts/terraform.sh destroy  # 스택 삭제 (먼저 Cloud Run 서비스·Job을 지워야 함)
# 별도 스택(기존 스택 옆에 시험용): GCP_NAME_SUFFIX=-tf GCP_SHARED_NETWORK=1 (사설망 피어링·Artifact Registry는 기존 것을 같이 쓴다)
# 엔진 프로젝트 ID: GCP_APP_PROJECT_ID (기본 prj_board). 그 밖의 terraform 인자는 뒤에 그대로 넘긴다 (예: -var sql_deletion_protection=false).
# GCP_AUTO_APPROVE=1(확인 없이 적용), GCP_ALLOW_DATA_LOSS=1(Cloud SQL 삭제·교체가 든 계획도 적용)
set -euo pipefail

: "${GCP_PROJECT:?GCP 프로젝트 ID를 GCP_PROJECT에 지정하세요}"
COMMAND="${1:-plan}"
case "$COMMAND" in plan|apply|destroy|output) ;; *) echo "사용법: terraform.sh plan|apply|destroy|output" >&2; exit 1 ;; esac
SUFFIX="${GCP_NAME_SUFFIX:-}"
WS="${GCP_PROJECT}${SUFFIX}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TF="$ROOT/infra/gcp/terraform"
CONFIG="${GCP_ADAPTER_CONFIG:-$ROOT/.data/gcp/$WS.json}"
# 별도 스택은 프로젝트에 하나뿐인 피어링·저장소를 만들지 않고 기존 것을 쓴다.
OWN_SHARED=true; [ -n "${GCP_SHARED_NETWORK:-}" ] && OWN_SHARED=false

# 다른 프로젝트에 자원을 만드는 사고를 막는다 (provision.sh와 같은 가드). provider는 사용자 ADC를 쓴다.
active="$(gcloud config get project 2>/dev/null || true)"
if [ "$active" != "$GCP_PROJECT" ]; then
  echo "gcloud 현재 프로젝트($active)가 GCP_PROJECT($GCP_PROJECT)와 다릅니다. 'gcloud config set project $GCP_PROJECT' 후 다시 실행하세요." >&2
  exit 1
fi

# Cloud Run 서비스가 남아 있으면 Direct VPC egress가 서브넷 IP를 잡고 있고, 어댑터 상태와도 어긋난다. 먼저 지우게 한다.
if [ "$COMMAND" = destroy ]; then
  service="shakedown-board$SUFFIX"
  if gcloud run services describe "$service" --region=asia-northeast3 --project="$GCP_PROJECT" >/dev/null 2>&1; then
    echo "Cloud Run 서비스 $service가 남아 있습니다. infra/gcp/README.md의 정리 순서대로 서비스와 Job을 먼저 지우세요." >&2
    exit 1
  fi
fi

# 상태 파일에는 DB 비밀번호가 들어간다. Git 밖(.data, gitignore)에 소유자만 읽게 둔다.
mkdir -p "$ROOT/.data/gcp/terraform"; chmod 700 "$ROOT/.data/gcp" "$ROOT/.data/gcp/terraform"
terraform -chdir="$TF" init -input=false >/dev/null
terraform -chdir="$TF" workspace select -or-create "$WS" >/dev/null
[ "$COMMAND" = output ] && exec terraform -chdir="$TF" output -json adapter_config

# 기본값은 variables.tf 한 곳에 두고, 지정한 값만 넘긴다.
args=(-var project="$GCP_PROJECT" -var name_suffix="$SUFFIX"
  -var create_private_service_access="$OWN_SHARED" -var create_artifact_repository="$OWN_SHARED" -var config_path="$CONFIG")
[ -n "${GCP_APP_PROJECT_ID:-}" ] && args+=(-var app_project_id="$GCP_APP_PROJECT_ID")

if [ "$COMMAND" != apply ]; then
  terraform -chdir="$TF" "$COMMAND" -input=false "${args[@]}" "${@:2}"
else
  # 어떤 이유로든 Cloud SQL 인스턴스·DB가 지워지거나 교체되는 계획이면 멈춘다 (데이터 이전 없음).
  # 계획 파일에는 비밀값이 들어가므로 .data(700)에 두고 끝나면 지운다.
  PLAN="$ROOT/.data/gcp/terraform/$WS.tfplan"
  trap 'rm -f "$PLAN"' EXIT
  terraform -chdir="$TF" plan -input=false -out="$PLAN" "${args[@]}" "${@:2}"
  doomed="$(terraform -chdir="$TF" show -json "$PLAN" | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const stateful = ["google_sql_database_instance", "google_sql_database"];
      for (const r of JSON.parse(s).resource_changes ?? [])
        if (stateful.includes(r.type) && r.change.actions.includes("delete")) console.log(r.address);
    });')"
  if [ -n "$doomed" ] && [ -z "${GCP_ALLOW_DATA_LOSS:-}" ]; then
    printf '이 계획은 Cloud SQL 자원을 지우거나 교체합니다 (데이터 이전 없음):\n%s\n정말 지우려면 GCP_ALLOW_DATA_LOSS=1.\n' "$doomed" >&2
    exit 1
  fi
  if [ -z "${GCP_AUTO_APPROVE:-}" ]; then
    read -r -p "위 계획을 적용할까요? (yes 입력): " ok
    [ "$ok" = yes ] || { echo '취소했습니다.' >&2; exit 1; }
  fi
  terraform -chdir="$TF" apply -input=false "$PLAN"

  # 어댑터가 읽는 것과 같은 스키마로 바로 검증한다.
  (cd "$ROOT" && node --import tsx --input-type=module -e \
    "import { loadConfig } from './infra/gcp/src/config.ts'; loadConfig(process.argv[1]);" "$CONFIG")
  echo "완료: $CONFIG"
  echo "다음: GCP_ADAPTER_CONFIG=$CONFIG 로 어댑터를 띄운다 (infra/gcp/README.md). 이미지는 scripts/publish-image.sh"
fi
