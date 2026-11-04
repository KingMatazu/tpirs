import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Registering a driver is a supervisory act.
 *
 * `asset:manage` covered both "add a vehicle" and "correct one". A collector
 * holds it for corrections, which also let a collector add vehicles — the
 * collector app's registration screen has now gone, and the API must not be the
 * place where the rule is forgotten. `asset:create` splits the two: a zone
 * supervisor and a system admin register, a collector does not.
 *
 * A system admin also gains `asset:manage`: the dashboard's first job for a new
 * deployment is putting drivers in the register, and reading the registry while
 * being unable to fix a typo is not a useful separation. Ledger and payment
 * permissions are untouched.
 *
 * Roles are inserted once per tenant, so this migration has to grant the new
 * permission to the role rows that already exist; tenants provisioned after it
 * pick the same set up from SYSTEM_ROLES.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, p.permission
    from (values
      ('system_admin', 'asset:manage'),
      ('system_admin', 'asset:create'),
      ('zone_supervisor', 'asset:create')
    ) as p(role_key, permission)
    join roles r on r.key = p.role_key
    where not exists (
      select 1 from role_permissions rp
      where rp.role_id = r.id and rp.permission = p.permission
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Exactly the grants this migration made, in the shape 0012 used for the cash
  // permissions: `asset:create` did not exist before this migration, and
  // `asset:manage` on system_admin was added here, so removing both returns the
  // seeded roles to their previous set.
  await sql`
    delete from role_permissions rp
    using (values
      ('system_admin', 'asset:manage'),
      ('system_admin', 'asset:create'),
      ('zone_supervisor', 'asset:create')
    ) as p(role_key, permission), roles r
    where rp.role_id = r.id and r.key = p.role_key and rp.permission = p.permission
  `.execute(db);
}
