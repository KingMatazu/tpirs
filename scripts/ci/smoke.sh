#!/usr/bin/env sh
# Minimal readiness + health smoke test. Defaults to the local API base URL.
set -eu

base_url="${1:-http://localhost:3000}"
deadline=$(( $(date +%s) + 60 ))

wait_for() {
  path="$1"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$base_url$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for $base_url$path" >&2
  return 1
}

echo "smoke: waiting for $base_url/v1/health"
wait_for "/v1/health"

echo "smoke: waiting for $base_url/v1/ready"
wait_for "/v1/ready"

health="$(curl -fsS "$base_url/v1/health")"
request_id="$(curl -fsSI "$base_url/v1/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')"

printf '%s' "$health" | grep -q '"status":"ok"'
if [ -z "$request_id" ]; then
  echo "missing x-request-id header" >&2
  exit 1
fi

echo "smoke: OK (request id: $request_id)"
