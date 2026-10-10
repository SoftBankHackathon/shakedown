#!/usr/bin/env bash
# 수동 준비용: 시연 앱을 linux/amd64 단일 manifest로 빌드해 ACR에 올리고 digest 주소를 출력한다.
# 실제 데모에서는 엔진이 한 번 빌드한 이미지를 각 대상 저장소로 복사한다 (README 4절).
#   bash infra/azure/scripts/publish-image.sh [태그]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CONFIG="${AZURE_ADAPTER_CONFIG:-$ROOT/.data/azure/config.json}"
TAG="${1:-$(git -C "$ROOT" rev-parse --short HEAD)-$(date +%s)}"
repo="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repositoryUri"])' "$CONFIG")"
meta="$(mktemp)"; trap 'rm -f "$meta"' EXIT

az acr login -n "${repo%%.*}" >/dev/null
# 어댑터는 다중 아키텍처 index를 거절하므로 provenance·sbom을 끄고 단일 manifest로 올린다.
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --metadata-file "$meta" -t "$repo:$TAG" --push "$ROOT/samples/kty-board" >&2
digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' "$meta")"
echo "$repo@$digest"
