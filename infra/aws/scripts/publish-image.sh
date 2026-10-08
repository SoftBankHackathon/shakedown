#!/usr/bin/env bash
set -euo pipefail
: "${HACKATHON_PUBLISH_PROFILE:?Choose the image publishing profile}"
: "${HACKATHON_ACCOUNT_ID:?Set the expected hackathon account ID}"
: "${HACKATHON_REPOSITORY:?Set the ECR repository name from stack outputs}"
: "${HACKATHON_IMAGE_TAG:?Set a unique tag, e.g. commit SHA}"
[[ "$HACKATHON_PUBLISH_PROFILE" != default ]] || { echo 'Use a named hackathon profile' >&2; exit 1; }
actual=$(aws --profile "$HACKATHON_PUBLISH_PROFILE" --region ap-northeast-2 sts get-caller-identity --query Account --output text)
[[ "$actual" == "$HACKATHON_ACCOUNT_ID" ]] || { echo 'Account mismatch' >&2; exit 1; }
registry="$HACKATHON_ACCOUNT_ID.dkr.ecr.ap-northeast-2.amazonaws.com"
aws --profile "$HACKATHON_PUBLISH_PROFILE" --region ap-northeast-2 ecr get-login-password | docker login --username AWS --password-stdin "$registry"
# One single-platform manifest ensures ECS imageDigest and the engine's digest are comparable.
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -t "$registry/$HACKATHON_REPOSITORY:$HACKATHON_IMAGE_TAG" --push "$(dirname "$0")/../../../samples/kty-board"
digest=$(aws --profile "$HACKATHON_PUBLISH_PROFILE" --region ap-northeast-2 ecr describe-images --repository-name "$HACKATHON_REPOSITORY" --image-ids "imageTag=$HACKATHON_IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text)
printf '%s/%s@%s\n' "$registry" "$HACKATHON_REPOSITORY" "$digest"
