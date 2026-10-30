#!/usr/bin/env sh
# Nightly backup (Phase 10, Step 8 / ADR 0043).
#
#   DATABASE_URL=postgres://... sh scripts/db/backup.sh [out-dir]
#
# Writes one directory per run:
#   database.dump        pg_dump --format=custom
#   object-store.tar.gz  the storage directory, when OBJECT_STORAGE_BACKUP_PATH is set
#   manifest.json        git SHA, migration version, row counts, checksums
#   checksums.sha256     for the artefacts above
#
# Retention keeps the newest BACKUP_KEEP directories (default 7). The off-site
# copy, encryption at rest and the storage location belong to the deploy target;
# this script only produces a consistent, verifiable artefact.
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"
. "$root/scripts/db/lib.sh"

out_root="${1:-${BACKUP_DIR:-$root/backups}}"
database_url="${DATABASE_URL:?DATABASE_URL is required}"
keep="${BACKUP_KEEP:-7}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$out_root/tpirs-$stamp"
mkdir -p "$target"

echo "backup: dumping $(db_name "$database_url") to $target"
run_pg pg_dump "$database_url" --format=custom --no-owner --no-privileges >"$target/database.dump"

echo "backup: object store"
object_store_json="$target/object-store.json"
if [ -n "${OBJECT_STORAGE_BACKUP_PATH:-}" ] && [ -d "${OBJECT_STORAGE_BACKUP_PATH}" ]; then
  tar -czf "$target/object-store.tar.gz" -C "$OBJECT_STORAGE_BACKUP_PATH" .
  printf '{"included":true,"source":"%s"}\n' "$OBJECT_STORAGE_BACKUP_PATH" >"$object_store_json"
else
  # A volume copy is not point-in-time consistent with the dump; the DR runbook
  # says how to treat photos referenced by restored rows.
  printf '{"included":false,"reason":"OBJECT_STORAGE_BACKUP_PATH not set"}\n' >"$object_store_json"
fi

echo "backup: manifest"
row_counts="$(run_psql "$database_url" "
  select table_name || '|' || (xpath('/row/c/text()',
    query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
  order by table_name")"

migration="$(run_psql "$database_url" "select coalesce(max(name), 'none') from kysely_migration")"
git_sha="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"

printf '%s\n' "$row_counts" >"$target/row-counts.txt"

node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const [target, migration, gitSha, db] = process.argv.slice(1);
const rows = Object.fromEntries(
  readFileSync(`${target}/row-counts.txt`, "utf8")
    .split("\n")
    .filter((line) => line.includes("|"))
    .map((line) => {
      const [table, count] = line.split("|");
      return [table, Number(count)];
    }),
);
writeFileSync(
  `${target}/manifest.json`,
  `${JSON.stringify({ createdAt: new Date().toISOString(), database: db, migration, gitSha, rowCounts: rows }, null, 2)}\n`,
);
' "$target" "$migration" "$git_sha" "$(db_name "$database_url")"

# Checksums last, so the manifest is covered too.
: >"$target/checksums.sha256"
for file in database.dump manifest.json row-counts.txt object-store.json object-store.tar.gz; do
  if [ -f "$target/$file" ]; then
    # Relative names, so `sha256sum -c checksums.sha256` works inside the dir.
    printf '%s  %s
' "$(sha256_of "$target/$file")" "$file" >>"$target/checksums.sha256"
  fi
done

echo "backup: pruning to the newest $keep"
# Newest first, drop everything past the retention count.
ls -1d "$out_root"/tpirs-* 2>/dev/null | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
  echo "backup: removing $old"
  rm -rf "$old"
done

echo "backup: OK"
echo "  $target"
echo "  rows: $(wc -l <"$target/row-counts.txt" | tr -d ' ') tables, migration $migration"
