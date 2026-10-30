#!/usr/bin/env sh
# Restore drill (Phase 10, Step 9 / ADR 0043).
#
#   sh scripts/db/restore-drill.sh
#
# Proves the recovery path end to end and prints the numbers an operator needs:
# back up a seeded database, restore it into a scratch database, check the data,
# then start the API against the restored copy and run the smoke test. The
# wall-clock restore time is the measured RTO input, not a guess.
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

container="tpirs-drill-$$"
work="$(mktemp -d)"
pg_port="${DRILL_PG_PORT:-55442}"
api_port="${DRILL_API_PORT:-3101}"
api_log="$work/api.log"
api_pid=""

cleanup() {
  if [ -n "$api_pid" ]; then kill "$api_pid" >/dev/null 2>&1 || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

echo "drill: starting a scratch postgres on :$pg_port"
docker run -d --name "$container" \
  -e POSTGRES_USER=tpirs \
  -e POSTGRES_PASSWORD=tpirs \
  -e POSTGRES_DB=tpirs \
  -p "$pg_port:5432" \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U tpirs -d tpirs >/dev/null 2>&1; then break; fi
  sleep 1
done

export DATABASE_URL="postgres://tpirs:tpirs@localhost:$pg_port/tpirs"
echo "drill: migrating and seeding the source"
pnpm --filter @tpirs/db migrate up >/dev/null
pnpm --filter @tpirs/db seed >/dev/null

echo "drill: backing up"
backup_started=$(date +%s)
sh scripts/db/backup.sh "$work" >/dev/null
backup_seconds=$(( $(date +%s) - backup_started ))
backup="$(ls -d "$work"/tpirs-* | head -1)"
dump_bytes=$(wc -c <"$backup/database.dump" | tr -d ' ')

echo "drill: restoring"
restore_started=$(date +%s)
restore_output="$(sh scripts/db/restore.sh "$backup")"
restore_seconds=$(( $(date +%s) - restore_started ))
restored_name="$(printf '%s' "$restore_output" | awk -F': *' '/target:/ { print $2 }')"
if [ -z "$restored_name" ]; then
  echo "drill: restore did not report a target database" >&2
  printf '%s\n' "$restore_output" >&2
  exit 1
fi

echo "drill: starting the API against the restored copy"
restored_url="postgres://tpirs:tpirs@localhost:$pg_port/$restored_name"
if [ ! -f apps/api/dist/index.js ]; then
  pnpm --filter @tpirs/api build >/dev/null
fi
DATABASE_URL="$restored_url" \
  API_PORT="$api_port" \
  SECRET_QR_TOKEN_SIGNING_KEY="${SECRET_QR_TOKEN_SIGNING_KEY:-drill-qr-signing-key}" \
  OBJECT_STORAGE_ADAPTER="${OBJECT_STORAGE_ADAPTER:-localdisk}" \
  OBJECT_STORAGE_LOCAL_DIR="$work/objects" \
  node apps/api/dist/index.js >"$api_log" 2>&1 &
api_pid=$!

ready="no"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$api_port/v1/ready" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 1
done
if [ "$ready" != "yes" ]; then
  echo "drill: the API did not become ready against the restored database" >&2
  tail -20 "$api_log" >&2
  exit 1
fi

echo "drill: smoke test against the restored copy"
sh scripts/ci/smoke.sh "http://localhost:$api_port" >/dev/null

cat <<REPORT

restore drill: PASSED
  date:            $(date -u +%Y-%m-%dT%H:%M:%SZ)
  dump size:       $dump_bytes bytes
  backup:          ${backup_seconds}s
  restore:         ${restore_seconds}s (measured RTO input)
  restored as:     $restored_name
  row counts:      matched the manifest
  ledger:          balances to zero
  migrations:      all applied
  API smoke:       /v1/health and /v1/ready answered, request id present
REPORT
