#!/usr/bin/env sh
# Starts a scratch Postgres, applies every migration, then rolls back to zero.
# Proves migrations are reversible.
set -eu

container="tpirs-migration-check-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$container" \
  -e POSTGRES_USER=tpirs \
  -e POSTGRES_PASSWORD=tpirs \
  -e POSTGRES_DB=tpirs \
  -p 55432:5432 \
  postgres:16-alpine >/dev/null

echo "waiting for postgres..."
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U tpirs -d tpirs >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="postgres://tpirs:tpirs@localhost:55432/tpirs"
pnpm --filter @tpirs/db migrate check
