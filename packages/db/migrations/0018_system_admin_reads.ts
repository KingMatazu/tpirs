import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * A system admin can see the operational screens, not just the settings ones.
 *
 * The dashboard landed every role on `/registry`, and `system_admin` held no
 * `asset:read` — so the person who installs and runs the deployment arrived on a
 * page missing from their own sidebar, and could not check that registration
 * works. Reading is not touching: `ledger:read`, `ledger:reverse`,
 * `ledger:approve` and `payment:manage` stay out, which is the separation the
 * brief requires (and `authz.test.ts` still asserts it).
 *
 * Only the reads are granted, and only where missing, so a tenant that narrowed
 * the role further is not silently widened.
 */
const READS = [
  "asset:read",
  "scan:read",
  "payment:read",
  "cash:read",
  "dispute:read",
  "report:read",
  "reconciliation:read",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const permission of READS) {
    await sql`
      insert into role_permissions (role_id, tenant_id, permission)
      select r.id, r.tenant_id, ${permission}
      from roles r
      where r.key = 'system_admin'
        and not exists (
          select 1 from role_permissions rp
          where rp.role_id = r.id and rp.permission = ${permission}
        )
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const permission of READS) {
    await sql`
      delete from role_permissions rp
      using roles r
      where rp.role_id = r.id
        and r.key = 'system_admin'
        and rp.permission = ${permission}
    `.execute(db);
  }
}
