#!/usr/bin/env sh
# Starts a scratch Postgres, applies migrations, then runs the whole test suite
# with TEST_DATABASE_URL set so DB-backed integration tests (RLS, auth, audit,
# identity) actually execute instead of skipping.
set -eu

container="tpirs-integration-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$container" \
  -e POSTGRES_USER=tpirs \
  -e POSTGRES_PASSWORD=tpirs \
  -e POSTGRES_DB=tpirs \
  -p 55433:5432 \
  postgres:16-alpine >/dev/null

echo "waiting for postgres..."
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U tpirs -d tpirs >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="postgres://tpirs:tpirs@localhost:55433/tpirs"
export TEST_DATABASE_URL="$DATABASE_URL"

pnpm --filter @tpirs/db migrate up
pnpm test
