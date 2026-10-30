#!/usr/bin/env sh
# Backup/restore check (Phase 10, Step 8).
#
# Proves the scripts work end to end on a throwaway database: migrate, seed,
# back up, restore into a scratch database, then confirm the restored copy has
# every migration applied. Step 9's drill adds the API smoke test on top; this is
# the part that runs on every change.
set -eu

container="tpirs-backup-$$"
work="$(mktemp -d)"
port="${BACKUP_CHECK_PORT:-55441}"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

docker run -d --name "$container" \
  -e POSTGRES_USER=tpirs \
  -e POSTGRES_PASSWORD=tpirs \
  -e POSTGRES_DB=tpirs \
  -p "$port:5432" \
  postgres:16-alpine >/dev/null

echo "backup-check: waiting for postgres"
for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U tpirs -d tpirs >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export DATABASE_URL="postgres://tpirs:tpirs@localhost:$port/tpirs"

echo "backup-check: migrating and seeding"
pnpm --filter @tpirs/db migrate up >/dev/null
pnpm --filter @tpirs/db seed >/dev/null

echo "backup-check: backing up"
sh scripts/db/backup.sh "$work" >/dev/null
backup="$(ls -d "$work"/tpirs-* | head -1)"

echo "backup-check: restoring into a scratch database"
restored_name="$(
  sh scripts/db/restore.sh "$backup" | awk -F': *' '/target:/ { print $2 }'
)"
if [ -z "$restored_name" ]; then
  echo "backup-check: restore did not report a target database" >&2
  exit 1
fi

echo "backup-check: checking migrations on the restored copy"
# `migrate check` rolls the schema back to zero, so it needs an empty database;
# on a restored copy the right question is "is anything pending?".
status="$(
  DATABASE_URL="postgres://tpirs:tpirs@localhost:$port/$restored_name" \
    pnpm --filter @tpirs/db migrate status 2>&1
)"
if printf '%s' "$status" | grep -q ': pending'; then
  echo "backup-check: the restored copy is missing migrations" >&2
  printf '%s\n' "$status" >&2
  exit 1
fi

echo "backup-check: OK ($restored_name restored and verified)"
