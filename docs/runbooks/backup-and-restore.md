# Runbook: backup and restore

Covers `scripts/db/backup.sh`, `scripts/db/restore.sh` and
`scripts/db/restore-drill.sh` (Phase 10, Steps 8–9; ADR 0043, D52).

**Targets: RPO 24 hours, RTO 2 hours for the pilot.** Measured, not assumed — the
drill at the bottom is the evidence.

## What a backup contains

| Artefact              | Contents                                                             |
| --------------------- | -------------------------------------------------------------------- |
| `database.dump`       | `pg_dump --format=custom` of the whole database                      |
| `object-store.tar.gz` | the storage directory, only when `OBJECT_STORAGE_BACKUP_PATH` is set |
| `object-store.json`   | says explicitly when the object store was **not** included           |
| `row-counts.txt`      | per-table row counts, the restore's comparison basis                 |
| `manifest.json`       | timestamp, database, migration, git SHA, row counts                  |
| `checksums.sha256`    | SHA-256 of the artefacts above                                       |

## Taking a backup

```sh
DATABASE_URL=postgres://… sh scripts/db/backup.sh /var/backups/tpirs
```

- `BACKUP_DIR` is the default output root; each run writes `tpirs-<UTC stamp>/`.
- `BACKUP_KEEP` (default `7`) keeps the newest directories and deletes the rest.
- `OBJECT_STORAGE_BACKUP_PATH` adds the object store to the same directory.
- `PG_IMAGE` overrides the fallback Postgres image when `pg_dump` is not installed
  locally; the script rewrites `localhost` for the container automatically.

**The nightly schedule, the off-site copy and encryption at rest belong to the
deploy target.** This repository produces a consistent artefact; it does not
pretend to know where a state keeps it. A dump contains password hashes and
session rows, so it is sensitive material: encrypted at rest, never attached to
a ticket, never committed.

## Restoring

```sh
# safe default: creates tpirs_restore_<timestamp> on the DATABASE_URL server
DATABASE_URL=postgres://… sh scripts/db/restore.sh /var/backups/tpirs/tpirs-20261030T020000Z

# explicit target (a scratch server you control)
DATABASE_URL=postgres://… sh scripts/db/restore.sh <backup-dir> postgres://…/tpirs_scratch
```

The script:

1. verifies `checksums.sha256`;
2. creates the scratch database when no target was given;
3. `pg_restore --clean --if-exists`;
4. compares every table's row count with the manifest;
5. asserts the ledger's debits equal credits and the migration table is populated.

Overwriting the live database needs its URL **and** `--force`. That asymmetry is
deliberate: the dangerous direction is never one typo away.

### Promoting a scratch restore

A restore is not a deployment. To make a restored database live:

1. Stop the API and the worker (they hold connections and timers).
2. Take a backup of the current database first, even if you believe it is lost —
   it may still hold the only copy of something.
3. Restore into a scratch database and let the checks pass.
4. Point `DATABASE_URL` at the restored database, start the worker, then the API.
5. Run `sh scripts/ci/smoke.sh`, then the reconciliation screen for yesterday.
6. Re-import any settlement statement from the provider for the gap window: the
   gateway's record is authoritative for payments the restore may have missed.

## Object storage

A volume copy is not point-in-time consistent with the database dump. After a
restore:

- a photo referenced by a restored row but missing from storage is re-uploaded by
  the owner or officer — it never blocks revenue;
- a photo that is newer than the database row is harmless.

## The drill

```sh
sh scripts/db/restore-drill.sh
```

Runs the whole path on a throwaway database: migrate → seed → back up → restore
into a scratch database → start the API against the restored copy → smoke test.
It prints the measured durations and exits non-zero on any failure.

### Recorded results

| Date       | Machine                                           | Dump   | Backup | Restore | Result |
| ---------- | ------------------------------------------------- | ------ | ------ | ------- | ------ |
| 2026-10-30 | Windows laptop, Docker Postgres, seeded demo data | 194 KB | 8 s    | 19 s    | passed |

The pilot's drill must be re-run on the target hardware and recorded here: a
194 KB demo database says nothing about a state's real volume, and the 2-hour RTO
claim is only as good as the largest drill that has actually run.

## When a backup is unusable

1. Check `checksums.sha256` first — a corrupt artefact must not be restored over
   a good database.
2. Fall back to the previous nightly directory (`BACKUP_KEEP` keeps seven).
3. If every dump is unusable, rebuild from the provider's settlement records and
   the append-only audit trail in the last good copy; record the gap in the
   incident log. This is the scenario the RPO exists for.
