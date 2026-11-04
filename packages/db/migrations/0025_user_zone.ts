import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * A zone supervisor belongs to a zone.
 *
 * Nothing linked a person to a zone before this: permissions were tenant-wide,
 * and a supervisor could register a driver anywhere in the state. The rule the
 * pilot needs is narrower — a supervisor registers vehicles in their own zone —
 * and it needs somewhere to record the answer, so `users.zone_id` holds the one
 * zone a person is responsible for.
 *
 * Nullable on purpose: most accounts (officers, finance, system admins) have no
 * zone, and an account whose roles change keeps the column untouched. The service
 * requires it only when the role set contains `zone_supervisor`, which is the
 * same shape as the collector profile: required for the role that needs it.
 *
 * The foreign key is to `zones(id)`; tenant agreement is enforced in the service,
 * which resolves the zone inside row-level security and therefore cannot see
 * another tenant's zone. A composite `(tenant_id, zone_id)` key would need an
 * extra unique index on `zones` for no additional protection a caller can reach.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
    add column zone_id uuid references zones(id)
  `.execute(db);

  await sql`create index users_zone_idx on users (zone_id) where zone_id is not null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists users_zone_idx`.execute(db);
  await sql`alter table users drop column if exists zone_id`.execute(db);
}
