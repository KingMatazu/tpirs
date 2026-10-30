#!/usr/bin/env sh
# Shared helpers for the backup and restore scripts (Phase 10, Step 8).
#
# `pg_dump` and `pg_restore` are not installed on every operator machine (and are
# deliberately absent from the app image), so each call falls back to the official
# Postgres image. A container cannot reach the host's `localhost`, so the URL is
# rewritten to `host.docker.internal` for that path only.
set -eu

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"

has_local_pg() {
  command -v "$1" >/dev/null 2>&1
}

# Rewrites a localhost URL so a container can reach the host. Anything else is
# left alone (a real hostname works from both sides).
container_url() {
  printf '%s' "$1" | sed -e 's#@localhost:#@host.docker.internal:#' -e 's#@127\.0\.0\.1:#@host.docker.internal:#'
}

# run_pg <binary> <url> [args...] — streams stdout.
run_pg() {
  binary="$1"
  url="$2"
  shift 2
  if has_local_pg "$binary"; then
    "$binary" "$@" "$url"
    return
  fi
  docker run --rm -i "$PG_IMAGE" "$binary" "$@" "$(container_url "$url")"
}

# run_pg_restore <url> <file> [args...] — pg_restore wants the file last and the
# database as an option, so it cannot reuse run_pg.
run_pg_restore() {
  url="$1"
  file="$2"
  shift 2
  if has_local_pg pg_restore; then
    pg_restore -d "$url" "$@" "$file"
    return
  fi
  # Git Bash on Windows rewrites `/backup/...` into a Windows path, and `pwd`
  # yields /c/... which Docker cannot mount. cygpath -m fixes the mount, and
  # MSYS_NO_PATHCONV keeps the in-container path intact.
  mount_dir="$(cd "$(dirname "$file")" && pwd)"
  if command -v cygpath >/dev/null 2>&1; then
    mount_dir="$(cygpath -m "$mount_dir")"
  fi
  MSYS_NO_PATHCONV=1 docker run --rm -i -v "$mount_dir:/backup" "$PG_IMAGE"     pg_restore -d "$(container_url "$url")" "$@" "/backup/$(basename "$file")"
}

# run_psql <url> <sql> — prints rows, tab-separated, no headers.
run_psql() {
  url="$1"
  sql="$2"
  if has_local_pg psql; then
    psql "$url" -At -F '|' -v ON_ERROR_STOP=1 -c "$sql"
    return
  fi
  docker run --rm -i "$PG_IMAGE" psql "$(container_url "$url")" -At -F '|' -v ON_ERROR_STOP=1 -c "$sql"
}

# Database name from a postgres URL, without printing the credentials.
db_name() {
  printf '%s' "$1" | sed -e 's#.*/##' -e 's#?.*##'
}

# Same server, different database name.
with_db_name() {
  url="$1"
  name="$2"
  printf '%s' "$url" | sed -e "s#/[^/?]*\(?.*\)\{0,1\}\$#/${name}\\1#"
}

# verify_checksums <dir> — checks checksums.sha256 in place.
verify_checksums() {
  dir="$1"
  [ -f "$dir/checksums.sha256" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && sha256sum -c --quiet checksums.sha256)
  else
    (cd "$dir" && shasum -a 256 -c checksums.sha256)
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
