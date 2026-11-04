import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Deleting a staff account leaves a tombstone, not a gap.
 *
 * `audit_log`, `ledger_entries`, scans, cash intakes and reversals all reference
 * `users(id)`, and the audit trail is append-only by design. A hard delete would
 * either fail on the foreign keys or, if they cascaded, erase the name behind
 * money movements — the one thing an auditor must always be able to resolve.
 *
 * So "delete" means: the login is gone and the person's details are cleared, and
 * the row remains as the subject of the history it took part in. `deleted_at`
 * marks it, `GET /v1/users` filters it out, the username is tombstoned so it can
 * be reused, and the password hash is replaced with a random one so no known
 * password can ever match it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table users add column deleted_at timestamptz`.execute(db);
  // The account list and the login lookup both filter on this, and the rows are
  // few, so a partial index keeps the common query off a sequential scan.
  await sql`
    create index users_active_idx on users (tenant_id)
    where deleted_at is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists users_active_idx`.execute(db);
  await sql`alter table users drop column if exists deleted_at`.execute(db);
}
