import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Top-level zone names were never actually unique.
 *
 * `zones` is declared `unique (tenant_id, parent_zone_id, name)`, which is
 * correct for children — a child always carries its parent's id, so two
 * "Market A" under the same parent collide. It does not hold for roots: in SQL
 * two `NULL`s are never equal, so every top-level zone's `parent_zone_id` counts
 * as distinct and `(tenant, NULL, 'Central')` can be inserted twice. The API
 * caught that only after the fact; this partial index makes "one 'Central' at
 * the top level" a database rule, matching what an operator sees on screen.
 *
 * The existing constraint stays: it is the right rule for non-null parents, and
 * dropping it would mean rebuilding a table that assets reference.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create unique index zones_tenant_root_name_key
    on zones (tenant_id, name)
    where parent_zone_id is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists zones_tenant_root_name_key`.execute(db);
}
