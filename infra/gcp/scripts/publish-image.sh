#!/usr/bin/env bash
set -euo pipefail
# 샘플 앱 이미지를 Artifact Registry에 올리고 "저장소@sha256:digest" 한 줄만 표준출력에 낸다.
# 사전 조건(1회): provision.sh 실행, gcloud auth configure-docker asia-northeast3-docker.pkg.dev
tag="${1:?사용법: publish-image.sh <태그, 예: git 커밋 SHA> [설정 파일]}"
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "Docker 태그 형식이 아닙니다: $tag" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
config="${2:-$here/../.data/config.json}"
# 저장소는 provision이 설정 파일에 적은 허용 접두어를 그대로 쓴다. 배포 API가 같은 접두어로 이미지를 검사하므로 둘이 어긋나지 않는다.
prefix="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).imagePrefixes?.[0] ?? ""' "$config" 2>/dev/null || true)"
[[ "$prefix" =~ ^[a-z0-9-]+-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9-]+/$ ]] || { echo "설정 파일에서 이미지 저장소를 읽지 못했습니다: $config (provision.sh를 먼저 실행하세요)" >&2; exit 1; }
repository="${prefix}kty-board"
metadata="$(mktemp)"
trap 'rm -f "$metadata"' EXIT
# Cloud Run은 linux/amd64만 돌린다. provenance·sbom을 끄면 단일 manifest가 되어
# 엔진이 넘기는 digest와 Cloud Run이 실제로 돌리는 digest가 같은 값이 된다(AWS와 같은 조건).
# 빌드 진행 출력은 표준오류로 돌려, 표준출력에는 결과 한 줄만 남긴다(호출하는 쪽이 그대로 읽는다).
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --metadata-file "$metadata" -t "$repository:$tag" --push "$here/../../../samples/kty-board" >&2
digest="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))["containerimage.digest"] ?? ""' "$metadata")"
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'push 결과에서 digest를 읽지 못했습니다.' >&2; exit 1; }
printf '%s@%s\n' "$repository" "$digest"
