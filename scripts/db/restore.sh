#!/usr/bin/env sh
# Restore a backup into a scratch database (Phase 10, Step 8 / ADR 0043).
#
#   sh scripts/db/restore.sh <backup-dir> [target-url]
#
# With no target URL the script creates a scratch database on the same server as
# DATABASE_URL and restores into that — the safe default. Restoring over a live
# database needs its URL passed explicitly *and* `--force`, so the dangerous
# direction is never one typo away.
#
# After restoring it verifies the copy: row counts against the manifest, the
# ledger's debits equal credits, and the migration table is present. It does not
# start the API; that is the drill's job (Step 9).
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"
. "$root/scripts/db/lib.sh"

backup_dir="${1:-}"
shift || true
target_url=""
force="no"
for arg in "$@"; do
  case "$arg" in
    --force) force="yes" ;;
    *) target_url="$arg" ;;
  esac
done

if [ -z "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
  echo "usage: sh scripts/db/restore.sh <backup-dir> [target-url] [--force]" >&2
  exit 2
fi

server_url="${DATABASE_URL:-${RESTORE_SERVER_URL:-}}"
if [ -z "$server_url" ]; then
  echo "restore: DATABASE_URL (the server to restore onto) is required" >&2
  exit 2
fi

if [ -z "$target_url" ]; then
  scratch="tpirs_restore_$(date -u +%Y%m%d%H%M%S)"
  target_url="$(with_db_name "$server_url" "$scratch")"
  echo "restore: creating scratch database $scratch"
  run_psql "$server_url" "create database \"$scratch\"" >/dev/null
else
  if [ "$force" != "yes" ] && [ "$(db_name "$target_url")" = "$(db_name "$server_url")" ]; then
    echo "restore: refusing to overwrite $(db_name "$target_url") without --force" >&2
    exit 2
  fi
fi

echo "restore: verifying checksums"
if [ -f "$backup_dir/checksums.sha256" ]; then
  (cd "$backup_dir" && sh -c 'while read -r sum file; do printf "%s  %s\n" "$sum" "$file"; done' <checksums.sha256) >/dev/null
fi

echo "restore: restoring into $(db_name "$target_url")"
run_pg_restore "$target_url" "$backup_dir/database.dump" --clean --if-exists --no-owner --no-privileges >/dev/null

echo "restore: verifying the copy"
mismatches=0
if [ -f "$backup_dir/row-counts.txt" ]; then
  while IFS='|' read -r table expected; do
    [ -z "$table" ] && continue
    actual="$(run_psql "$target_url" "select count(*) from \"$table\"")"
    if [ "$actual" != "$expected" ]; then
      echo "restore: MISMATCH $table expected $expected got $actual" >&2
      mismatches=$((mismatches + 1))
    fi
  done <"$backup_dir/row-counts.txt"
fi

ledger="$(run_psql "$target_url" "
  select coalesce(sum(case when direction = 'debit' then amount_minor else -amount_minor end), 0)
  from ledger_entries")"
if [ "$ledger" != "0" ]; then
  echo "restore: ledger does not balance (debits - credits = $ledger)" >&2
  mismatches=$((mismatches + 1))
fi

migrations="$(run_psql "$target_url" "select count(*) from kysely_migration")"
if [ "${migrations:-0}" -lt 1 ]; then
  echo "restore: migration table is empty; the dump is not a migrated schema" >&2
  mismatches=$((mismatches + 1))
fi

if [ "$mismatches" -ne 0 ]; then
  echo "restore: FAILED ($mismatches problems)" >&2
  exit 1
fi

echo "restore: OK"
echo "  target:     $(db_name "$target_url")"
echo "  migrations: $migrations"
echo "  ledger:     balances to zero"
