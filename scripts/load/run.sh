#!/usr/bin/env sh
# Load run against a scratch database (Phase 10, Step 3 / ADR 0041).
#
#   sh scripts/load/run.sh verify 200 20
#
# Starts a throwaway Postgres, migrates, seeds the demo tenants, builds and
# starts the API against it, mints a verify token, runs the scenario, and tears
# everything down. Load never points at a database anyone cares about.
set -eu

scenario="${1:-verify}"
rate="${2:-200}"
duration="${3:-20}"
shift 3 2>/dev/null || true

container="tpirs-load-$$"
api_log="$(mktemp)"
api_pid=""

cleanup() {
  [ -n "$api_pid" ] && kill "$api_pid" >/dev/null 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$api_log"
}
trap cleanup EXIT INT TERM

docker run -d --name "$container" \
  -e POSTGRES_USER=tpirs \
  -e POSTGRES_PASSWORD=tpirs \
  -e POSTGRES_DB=tpirs \
  -p 55435:5432 \
  postgres:16-alpine >/dev/null

echo "load: waiting for postgres"
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U tpirs -d tpirs >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="postgres://tpirs:tpirs@localhost:55435/tpirs"
export SECRET_QR_TOKEN_SIGNING_KEY="${SECRET_QR_TOKEN_SIGNING_KEY:-load-test-qr-signing-key}"
export API_PORT="${LOAD_API_PORT:-3100}"
# Local disk storage: the load run must not need the object-store container.
export OBJECT_STORAGE_ADAPTER="${OBJECT_STORAGE_ADAPTER:-localdisk}"
export OBJECT_STORAGE_LOCAL_DIR="${OBJECT_STORAGE_LOCAL_DIR:-$(mktemp -d)}"
# The budgets measure the route, not the abuse limiter; the API ignores this
# outside a non-production run.
export LOAD_TEST_DISABLE_RATE_LIMITS=true

echo "load: migrating and seeding"
pnpm --filter @tpirs/db migrate up >/dev/null
pnpm --filter @tpirs/db seed >/dev/null

echo "load: building the API and the packages the seeder imports"
pnpm --filter @tpirs/db --filter @tpirs/domain --filter @tpirs/crypto --filter @tpirs/api build >/dev/null

node apps/api/dist/index.js >"$api_log" 2>&1 &
api_pid=$!

echo "load: waiting for the API on :$API_PORT"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$API_PORT/v1/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

seeded="$(node scripts/load/seed.mjs)"
verify_token="$(printf '%s' "$seeded" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.parse(s).verifyToken)})")"
webhook_token="$(printf '%s' "$seeded" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(JSON.parse(s).webhookToken)})")"

node scripts/load/run.mjs \
  --scenario "$scenario" \
  --rate "$rate" \
  --duration "$duration" \
  --base-url "http://localhost:$API_PORT" \
  --verify-token "$verify_token" \
  --webhook-token "$webhook_token" \
  "$@"
