#!/usr/bin/env bash
set -euo pipefail
# 실측(spike). 배포 API를 만들기 전에 Cloud Run에 샘플 앱을 gcloud로 임시로 띄워,
# 설계를 바꿀 수 있는 사실 6가지를 잰다. 결과는 표준출력으로만 낸다(사람이 _workspace/spike.md에 옮긴다).
#   a 로그인 풀림   b 0대로 내린 뒤 막히기까지   c allUsers 회수·재부여 반영 시간
#   d 서버마다 X-Instance-Id가 다른지   e 사설망 DB 첫 연결 지연   f schema-init Job 시간
# 비용이 나는 임시 자원(서비스 shakedown-spike, Job shakedown-spike-schema)은 성공·실패와 상관없이 끝에서 지운다.
image="${1:?사용법: spike.sh <저장소@sha256:digest> [설정 파일]}"
here="$(cd "$(dirname "$0")" && pwd)"
config="${2:-$here/../.data/config.json}"
image_pattern='^asia-northeast3-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9-]+/[a-z0-9-]+@sha256:[a-f0-9]{64}$'
[[ "$image" =~ $image_pattern ]] || { echo "Artifact Registry의 @sha256 digest 이미지를 주세요: $image" >&2; exit 1; }
# 키가 없으면 빈 값으로 넘어가지 않고 멈춘다(엉뚱한 주소로 10분씩 기다리지 않게). 값마다 따로 읽어야 set -e가 실패를 잡는다.
setting() {
  node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    if (v === undefined || v === "") { console.error(`설정 파일에 ${process.argv[2]} 값이 없습니다.`); process.exit(1); }
    console.log(v);' "$config" "$1"
}
project="$(setting gcpProject)"
number="$(setting gcpProjectNumber)"
region="$(setting region)"
secret="$(setting dbPasswordSecret)"
db_host="$(setting dbHost)"
db_name="$(setting dbName)"
db_user="$(setting dbUsername)"
# 앱 설정은 배포 API와 같은 값(AWS와도 같음): DDL validate, demo 프로필, TZ=UTC, 비밀번호는 Secret Manager 참조.
common_env="SPRING_DATASOURCE_URL=jdbc:postgresql://$db_host:5432/$db_name|SPRING_DATASOURCE_USERNAME=$db_user|TZ=UTC"
service=shakedown-spike
job=shakedown-spike-schema
url="https://$service-$number.$region.run.app"
# 이번 실행 이후 로그만 본다(같은 이름으로 예전에 돌린 기록과 섞이지 않게).
filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$service\" AND timestamp>=\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
active="$(gcloud config get project 2>/dev/null || true)"
[[ "$active" == "$project" ]] || { echo "gcloud 현재 프로젝트($active)가 설정($project)과 다릅니다." >&2; exit 1; }

work="$(mktemp -d)"
remove_spike() {
  gcloud run services delete "$service" --region="$region" --project="$project" --quiet >/dev/null 2>&1 || true
  gcloud run jobs delete "$job" --region="$region" --project="$project" --quiet >/dev/null 2>&1 || true
}
cleanup() { echo '==> 정리: 임시 서비스·Job 삭제'; remove_spike; rm -rf "$work"; }
trap cleanup EXIT
remove_spike # 앞선 실행이 중간에 끊겨 남은 자원이 있으면 먼저 지운다.

# 공개 주소 /health가 기대 코드(셸 패턴)가 될 때까지 2초마다 보고, 걸린 초를 전역 변수 waited에 남긴다(시간 초과는 -1).
waited=-1
wait_status() {
  local pattern="$1" limit="$2" label="$3" start=$SECONDS code=''
  while (( SECONDS - start < limit )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url/health" || true)"
    if [[ "$code" == $pattern ]]; then
      waited=$((SECONDS - start)); echo "$label: ${waited}초 (HTTP $code)"; return 0
    fi
    sleep 2
  done
  waited=-1; echo "$label: ${limit}초 안에 바뀌지 않음 (마지막 HTTP $code)"
}
# 응답 헤더 파일들에서 X-Instance-Id 값만 뽑는다.
instance_ids() { cat "$@" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "x-instance-id" { print $2 }'; }

echo '==> f. schema-init Job 생성·실행 (배포 API가 매 배포 할 일)'
started=$SECONDS
gcloud run jobs create "$job" --image="$image" --region="$region" --project="$project" \
  --network=default --subnet=default --vpc-egress=private-ranges-only \
  --set-env-vars="^|^SPRING_PROFILES_ACTIVE=schema-init|SPRING_JPA_HIBERNATE_DDL_AUTO=update|$common_env" \
  --set-secrets="SPRING_DATASOURCE_PASSWORD=$secret:latest" \
  --memory=1Gi --cpu=1 --max-retries=0 --task-timeout=600 --quiet
job_created=$((SECONDS - started))
gcloud run jobs execute "$job" --region="$region" --project="$project" --wait --quiet
job_total=$((SECONDS - started))
echo "f. Job 생성 ${job_created}초, 생성+실행 완료 ${job_total}초"

echo '==> 서비스 배포 (수동 2대, Direct VPC egress, 비밀값 env, session-memory, 스티키 끔)'
started=$SECONDS
gcloud run deploy "$service" --image="$image" --region="$region" --project="$project" \
  --scaling=2 --network=default --subnet=default --vpc-egress=private-ranges-only \
  --set-env-vars="^|^SPRING_PROFILES_ACTIVE=demo,session-memory|SPRING_JPA_HIBERNATE_DDL_AUTO=validate|$common_env" \
  --set-secrets="SPRING_DATASOURCE_PASSWORD=$secret:latest" \
  --memory=1Gi --cpu=1 --port=8080 --no-session-affinity --allow-unauthenticated --quiet
deployed=$((SECONDS - started))
echo "서비스 배포 ${deployed}초"
wait_status 200 600 '배포 후 공개 /health 200까지'
first_health=$waited
# 서비스가 뜨지 않았으면 뒤의 측정은 의미가 없다(합계에 -1이 섞여 통과처럼 보이지 않게 여기서 멈춘다).
(( first_health >= 0 )) || exit 1

echo '==> a. 로그인 풀림: 가입 → 로그인 → /board 20회 (쿠키는 로그인 응답 것으로 고정)'
jar="$work/cookies"
email="spike$(date +%s)@example.com"
pw="spike-$(date +%s)"
curl -s -o /dev/null -c "$jar" --data-urlencode "email=$email" --data-urlencode 'nickname=spike' --data-urlencode "password=$pw" "$url/join"
login="$(curl -s -o /dev/null -c "$jar" -b "$jar" -w '%{http_code} %{redirect_url}' --data-urlencode "email=$email" --data-urlencode "password=$pw" "$url/login")"
# 쿠키를 받기 전 첫 응답이라 서버가 세션 번호를 주소 뒤(;SESSION=…)에 붙여 보낼 수 있다. 목적지가 /board면 로그인 성공이다.
[[ "$login" == "302 "*"/board" || "$login" == "302 "*"/board;"* ]] || { echo "로그인이 /board로 가지 않았습니다: $login"; exit 1; }
bounced=0
for i in $(seq 1 20); do
  # -c 없이 -b만 쓴다: 다른 서버가 새 SESSION 쿠키를 줘도 다음 요청은 로그인한 서버의 쿠키를 그대로 보낸다.
  code="$(curl -s -o /dev/null -D "$work/board$i" -b "$jar" -w '%{http_code}' "$url/board")"
  if [[ "$code" == 302 ]]; then bounced=$((bounced + 1)); fi
done
echo "a. /board 20회 중 로그인 화면으로 튕김: ${bounced}회"
echo 'a. 응답한 서버(X-Instance-Id)별 횟수:'
instance_ids "$work"/board* | sort | uniq -c

echo '==> d. 서버마다 X-Instance-Id가 다른지: /health 동시 20회 + 로그에 찍힌 인스턴스 수'
for i in $(seq 1 20); do curl -s -o /dev/null -D "$work/health$i" "$url/health" & done
wait
instance_ids "$work"/health* | sort | uniq -c
distinct="$(instance_ids "$work"/board* "$work"/health* | sort -u | grep -c . || true)"
instances="$(gcloud logging read "$filter" --project="$project" --format='value(labels.instanceId)' | sort -u | grep -c . || true)"
echo "d. X-Instance-Id 종류 ${distinct}개, 로그의 인스턴스 ${instances}개"

echo '==> e. 기동 로그: 시작 → DB 첫 연결(HikariPool-1 Start completed) → 기동 완료 (인스턴스별)'
gcloud logging read "$filter AND (textPayload:\"Starting BoardProjectApplication\" OR textPayload:\"HikariPool-1 - Start completed\" OR textPayload:\"Started BoardProjectApplication\")" \
  --project="$project" --order=asc --format='value(timestamp,labels.instanceId,textPayload)'

echo '==> c. allUsers 회수 → 403까지, 다시 부여 → 200까지'
gcloud run services remove-iam-policy-binding "$service" --region="$region" --project="$project" --member=allUsers --role=roles/run.invoker >/dev/null
wait_status 403 600 'c. 회수 후 403까지'
revoked=$waited
gcloud run services add-iam-policy-binding "$service" --region="$region" --project="$project" --member=allUsers --role=roles/run.invoker >/dev/null
wait_status 200 600 'c. 재부여 후 200까지'
regranted=$waited

echo '==> b. 수동 0대로 내린 뒤 공개 주소가 2xx가 아니게 되기까지'
# 배포 API(setInstances)가 쓸 REST 호출을 그대로 써서, 잰 값을 설계에 바로 옮길 수 있게 한다.
# gcloud는 표준출력도 로그 파일에 적으므로, 토큰을 내는 호출은 그 한 번만 파일 로그를 끈다.
# 토큰은 표준입력(-H @-)으로 넘긴다. curl 인자로 주면 요청 중에 프로세스 목록(ps)에 그대로 보인다.
patch_code="$(printf 'Authorization: Bearer %s\n' "$(CLOUDSDK_CORE_DISABLE_FILE_LOGGING=true gcloud auth print-access-token)" \
  | curl -s -o "$work/patch.json" -w '%{http_code}' -X PATCH -H @- -H "x-goog-user-project: $project" \
  -H 'Content-Type: application/json' --data '{"scaling":{"manualInstanceCount":0}}' \
  "https://run.googleapis.com/v2/projects/$project/locations/$region/services/$service?updateMask=scaling.manualInstanceCount")"
[[ "$patch_code" == 200 ]] || { echo "0대 PATCH 실패: HTTP $patch_code"; cat "$work/patch.json"; exit 1; }
# curl 자체 실패(000)는 서버 응답이 아니라서 세지 않는다.
wait_status '[1345]??' 120 'b. 0대 요청 후 2xx가 아니게 되기까지'
zeroed=$waited

echo
echo '==== 요약 (-1은 시간 초과) ===='
echo "a 로그인 풀림: /board 20회 중 ${bounced}회 튕김"
echo "b 0대 → 2xx 아님: ${zeroed}초 (기준 20초 이하)"
echo "c 회수 → 403: ${revoked}초 / 재부여 → 200: ${regranted}초 (재공개 기준 420초 이하)"
echo "d X-Instance-Id 종류 ${distinct}개 / 로그 인스턴스 ${instances}개"
echo "e 위 기동 로그에서 인스턴스별 (HikariPool 시각 - Starting 시각)을 계산한다"
echo "f Job 생성+실행 ${job_total}초 + 서비스 배포 ${deployed}초 + health ${first_health}초 = $((job_total + deployed + first_health))초 (기준 420초 이하)"
