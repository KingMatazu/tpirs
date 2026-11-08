import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Taking cash is a field act: finance reconciles it, never performs it.
 *
 * Finance held `cash:intake` since migration 0012, so a finance administrator
 * could open any collector's wallet and record an intake for them — settling a
 * driver's day out of that collector's float. Under the prepaid model that is a
 * direct debit on somebody else's money (ADR 0069), and even under postpaid it
 * manufactures a debt the collector did not incur.
 *
 * A zone supervisor keeps the ability because they are on the ground and may
 * need to record for a collector whose phone has failed; they gain the
 * permission here because migration 0012 never granted it to them, which is why
 * only finance could use the admin "take cash" form.
 *
 * Grants are additive at deploy time; this migration both adds (supervisor) and
 * removes (finance). Removing a permission is safe in any order; the added key
 * already exists in the running build.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from role_permissions rp
    using roles r
    where rp.role_id = r.id
      and r.key = 'finance_admin'
      and rp.permission = 'cash:intake'
  `.execute(db);
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, 'cash:intake'
    from roles r
    where r.key = 'zone_supervisor'
    on conflict (role_id, permission) do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore the pre-0070 grants exactly.
  await sql`
    delete from role_permissions rp
    using roles r
    where rp.role_id = r.id
      and r.key = 'zone_supervisor'
      and rp.permission = 'cash:intake'
  `.execute(db);
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, 'cash:intake'
    from roles r
    where r.key = 'finance_admin'
    on conflict (role_id, permission) do nothing
  `.execute(db);
}
