#!/usr/bin/env sh
# Security suite (Phase 10, Step 11): dependency audit, the route × role matrix
# and the row-level-security coverage guard, against a scratch database so the
# DB-backed suites actually run.
#
#   sh scripts/ci/security.sh
#
# The access-matrix suite is static, but it lives in the API package and is run
# here anyway: one command that answers "is the security posture still what we
# think it is?" is worth more than three remembered filters.
set -eu

container="tpirs-security-$$"
port="${SECURITY_DB_PORT:-55445}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "security: dependency audit"
sh scripts/ci/audit.sh

echo "security: starting a scratch postgres on :$port"
docker run -d --name "$container" \
  -e POSTGRES_USER=tpirs \
  -e POSTGRES_PASSWORD=tpirs \
  -e POSTGRES_DB=tpirs \
  -p "$port:5432" \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U tpirs -d tpirs >/dev/null 2>&1; then break; fi
  sleep 1
done

export DATABASE_URL="postgres://tpirs:tpirs@localhost:$port/tpirs"
export TEST_DATABASE_URL="$DATABASE_URL"
pnpm --filter @tpirs/db migrate up >/dev/null

echo "security: route × role access matrix"
pnpm --filter @tpirs/api exec vitest run src/routes/access-matrix.test.ts

echo "security: row-level security coverage"
pnpm --filter @tpirs/db exec vitest run src/rls-coverage.test.ts

echo "security: OK"
