import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Let the deploying role assume `tpirs_app`.
 *
 * Every tenant-scoped query runs `set local role tpirs_app` inside its
 * transaction (ADR 0006). That works locally because the Docker `POSTGRES_USER`
 * is a superuser — a superuser may `SET ROLE` to anything. A managed Postgres
 * (Supabase, RDS) often gives the application role database admin rights but not
 * superuser, and then `SET ROLE` fails with "permission denied" on the first
 * request even though every migration succeeded.
 *
 * Migrations run as the role that owns the schema and created `tpirs_app`, so it
 * can grant the membership to itself here. `current_user`, not a literal role
 * name, keeps this true for both the local `tpirs` user and a provider's
 * `postgres` user.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`grant tpirs_app to current_user`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The role may already be gone if 0002's down ran first; the migration runner
  // rolls back in reverse order, so it has not, but `if exists` costs nothing.
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'tpirs_app') then
        revoke tpirs_app from current_user;
      end if;
    end
    $$
  `.execute(db);
}
