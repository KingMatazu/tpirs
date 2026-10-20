#!/usr/bin/env sh
# Builds nothing: takes a pushed image reference, brings up the staging profile
# against it, runs migrations (blocking, exit code checked), waits for health,
# runs the smoke test, and tears everything down.
#
# Usage: scripts/ci/staging-smoke.sh <image-ref>
#   image-ref: full image reference including tag (repo/name:tag)
set -eu

image_ref="${1:-}"
if [ -z "$image_ref" ]; then
  echo "usage: scripts/ci/staging-smoke.sh <image-ref>" >&2
  exit 2
fi

compose_file="infra/docker-compose.staging.yml"
export IMAGE_REF="$image_ref"

cleanup() {
  docker compose -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Bring up dependencies (postgres, redis, object store). The api is started
# after migrations so readiness can only pass once the schema exists.
docker compose -f "$compose_file" up -d --wait --wait-timeout 180 postgres redis object-store

echo "running migrations..."
docker compose -f "$compose_file" run --rm migrate

echo "starting api..."
docker compose -f "$compose_file" up -d --wait --wait-timeout 180 api

scripts/ci/smoke.sh "http://localhost:3000"
