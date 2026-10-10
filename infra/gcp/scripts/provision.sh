#!/usr/bin/env bash
set -euo pipefail
# GCP 1회 준비 스크립트. 사람이 직접 실행한다(배포 API 기동·테스트는 이 파일을 부르지 않는다).
# 몇 분씩 걸리는 자원(사설망 피어링, Cloud SQL)을 배포 버튼과 분리해 미리 만들고,
# 배포 API가 읽을 설정 파일을 쓴다. 다시 돌려도 안전하도록 모든 자원은 describe로 먼저 보고 없을 때만 만든다.
project="${1:?사용법: provision.sh <GCP 프로젝트 ID> [설정 파일 경로]}"
here="$(cd "$(dirname "$0")" && pwd)"
config="${2:-$here/../.data/config.json}"
app_project="${GCP_APP_PROJECT_ID:-prj_board}"
region=asia-northeast3
repo=shakedown
psa_range=shakedown-psa
instance=shakedown-pg
db_name=board_db
db_user=board
secret=shakedown-db-password
ipv4='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'

[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "GCP 프로젝트 ID 형식이 아닙니다: $project" >&2; exit 1; }
# 설정 파일에 그대로 들어가는 값이라 따옴표 같은 문자를 막는다(엔진 project_id 규칙과 같다).
[[ "$app_project" =~ ^[a-zA-Z0-9_-]{1,64}$ ]] || { echo 'GCP_APP_PROJECT_ID는 영문·숫자·_·- 1~64자여야 합니다.' >&2; exit 1; }
# 다른 프로젝트에 자원을 만드는 사고를 막는다: gcloud 현재 프로젝트가 인자와 같을 때만 진행한다.
active="$(gcloud config get project 2>/dev/null || true)"
[[ "$active" == "$project" ]] || { echo "gcloud 현재 프로젝트($active)가 인자($project)와 다릅니다. 'gcloud config set project $project' 후 다시 실행하세요." >&2; exit 1; }

echo '==> API 켜기'
gcloud services enable run.googleapis.com sqladmin.googleapis.com compute.googleapis.com \
  servicenetworking.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudresourcemanager.googleapis.com logging.googleapis.com --project="$project"
number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
[[ "$number" =~ ^[0-9]{6,20}$ ]] || { echo '프로젝트 번호를 읽지 못했습니다.' >&2; exit 1; }

echo "==> Artifact Registry 저장소 $repo"
if ! gcloud artifacts repositories describe "$repo" --location="$region" --project="$project" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$repo" --repository-format=docker --location="$region" --project="$project"
fi

echo '==> 사설망 연결(Private Services Access)'
# Cloud SQL 사설 IP는 VPC와 Google 서비스망의 피어링이 먼저 있어야 만들 수 있다.
if ! gcloud compute addresses describe "$psa_range" --global --project="$project" >/dev/null 2>&1; then
  gcloud compute addresses create "$psa_range" --global --purpose=VPC_PEERING --prefix-length=16 --network=default --project="$project"
fi
if [[ -z "$(gcloud services vpc-peerings list --network=default --service=servicenetworking.googleapis.com --format='value(peering)' --project="$project")" ]]; then
  gcloud services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges="$psa_range" --network=default --project="$project"
fi

echo "==> Cloud SQL PostgreSQL $instance"
created=no
started=$SECONDS
if ! gcloud sql instances describe "$instance" --project="$project" >/dev/null 2>&1; then
  # PostgreSQL 16 이상은 edition을 안 주면 Enterprise Plus가 되어 최소 사양(db-f1-micro)을 쓸 수 없다.
  # 생성은 몇 분 걸리고 gcloud 대기가 먼저 끝날 수 있어서, --async로 요청만 보내고 아래에서 상태를 직접 기다린다.
  gcloud sql instances create "$instance" --database-version=POSTGRES_17 --edition=enterprise --tier=db-f1-micro \
    --region="$region" --availability-type=zonal --network=default --no-assign-ip --async --project="$project"
  created=yes
fi
# 앞선 실행이 생성 요청만 보내고 끊겼어도(창을 닫음, 명령 시간 제한) 다시 실행하면 여기서 RUNNABLE까지 이어서 기다린다.
state=''
for _ in $(seq 1 120); do
  state="$(gcloud sql instances describe "$instance" --format='value(state)' --project="$project" || true)"
  [[ "$state" == RUNNABLE ]] && break
  # 생성이 실패했거나 지워지는 중이면 기다려도 RUNNABLE이 되지 않는다.
  if [[ "$state" == FAILED || "$state" == SUSPENDED || "$state" == PENDING_DELETE ]]; then
    echo "Cloud SQL 상태가 $state입니다. 기다려도 준비되지 않으니 콘솔에서 원인을 확인하세요." >&2; exit 1
  fi
  sleep 15
done
[[ "$state" == RUNNABLE ]] || { echo "Cloud SQL이 30분 안에 준비되지 않았습니다(마지막 상태: $state). 잠시 뒤 다시 실행하세요." >&2; exit 1; }
if [[ "$created" == yes ]]; then echo "Cloud SQL 생성 시간: $((SECONDS - started))초"; fi
read -r ip_type db_host <<<"$(gcloud sql instances describe "$instance" --format='value(ipAddresses[0].type,ipAddresses[0].ipAddress)' --project="$project")"
[[ "$ip_type" == PRIVATE && "$db_host" =~ $ipv4 ]] || { echo 'Cloud SQL 사설 IP를 읽지 못했습니다. 인스턴스 상태를 확인하세요.' >&2; exit 1; }

echo "==> DB $db_name"
if ! gcloud sql databases describe "$db_name" --instance="$instance" --project="$project" >/dev/null 2>&1; then
  gcloud sql databases create "$db_name" --instance="$instance" --project="$project"
fi

echo "==> DB 비밀번호(Secret Manager $secret)"
# 비밀번호는 Secret Manager에만 둔다. 화면·설정 파일·명령 인자·gcloud 로그 파일 어디에도 남기지 않는다.
# gcloud는 받은 인자와 표준출력을 ~/.config/gcloud/logs 파일에도 적는다. 그래서 비밀번호가 인자나 출력으로
# 지나가는 gcloud 호출은 CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true(그 한 번만 core/disable_file_logging 켜기)로 부른다.
password=''
if ! gcloud secrets describe "$secret" --project="$project" >/dev/null 2>&1; then
  gcloud secrets create "$secret" --replication-policy=automatic --project="$project"
fi
# 비밀 만들기와 값 넣기는 따로 가는 호출이라, 그 사이에서 끊기면 값 없는 비밀만 남는다. 그래서 쓸 수 있는 값이 있는지 따로 본다.
# 사용자보다 비밀값을 먼저 저장한다. 중간에 멈춰도 다음 실행이 같은 비밀번호로 사용자를 만든다.
if [[ -z "$(gcloud secrets versions list "$secret" --filter=state=ENABLED --limit=1 --format='value(name)' --project="$project")" ]]; then
  password="$(openssl rand -hex 24)"
  printf '%s' "$password" | gcloud secrets versions add "$secret" --data-file=- --project="$project"
fi

echo "==> DB 사용자 $db_user"
# gcloud sql users create·set-password는 비밀번호를 --password 인자로만 받고, 인자는 프로세스 목록에 보인다.
# 그래서 권한 600 임시 파일에 담아 --flags-file로 넘기고 바로 지운다.
user_flags="$(mktemp)"
trap 'rm -f "$user_flags"' EXIT
if ! gcloud sql users describe "$db_user" --instance="$instance" --project="$project" >/dev/null 2>&1; then
  [[ -n "$password" ]] || password="$(CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true gcloud secrets versions access latest --secret="$secret" --project="$project")"
  printf '{"--password": "%s"}\n' "$password" > "$user_flags"
  CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true gcloud sql users create "$db_user" --instance="$instance" --flags-file="$user_flags" --project="$project"
elif [[ -n "$password" ]]; then
  # 이번 실행에서 새 비밀번호를 만들었는데 사용자는 이미 있다(비밀을 지웠다 다시 만든 경우). 사용자 쪽을 새 값에 맞춘다.
  printf '{"--password": "%s"}\n' "$password" > "$user_flags"
  CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true gcloud sql users set-password "$db_user" --instance="$instance" --flags-file="$user_flags" --project="$project"
fi
rm -f "$user_flags"
password=''

echo '==> Cloud Run 실행 계정에 비밀값 읽기 권한'
# 서비스 계정을 따로 지정하지 않으면 Cloud Run 서비스와 Job은 Compute Engine 기본 서비스 계정으로 돈다.
# 같은 바인딩을 다시 넣어도 정책은 그대로라 매번 호출해도 안전하다.
gcloud secrets add-iam-policy-binding "$secret" --member="serviceAccount:${number}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor --project="$project" >/dev/null

echo "==> 설정 파일 $config"
# 키 이름은 src/config.ts의 configSchema와 같다. 비밀값은 이름(dbPasswordSecret)만 들어간다.
mkdir -p "$(dirname "$config")"
cat > "$config" <<EOF
{
  "gcpProject": "$project",
  "gcpProjectNumber": "$number",
  "region": "$region",
  "projectId": "$app_project",
  "serviceName": "shakedown-board",
  "jobName": "shakedown-board-schema",
  "imagePrefixes": ["$region-docker.pkg.dev/$project/$repo/"],
  "network": "default",
  "subnetwork": "default",
  "dbHost": "$db_host",
  "dbName": "$db_name",
  "dbUsername": "$db_user",
  "dbPasswordSecret": "$secret",
  "port": 8080,
  "memory": "1Gi",
  "cpu": "1"
}
EOF
echo "완료: $config"
