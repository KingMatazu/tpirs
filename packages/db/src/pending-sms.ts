import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "./connection.js";
import { APP_ROLE } from "./tenant-scope.js";

/** One pending outbox row: which tenant it belongs to, and which message. */
export interface PendingSmsRef {
  readonly tenantId: string;
  readonly smsId: string;
}

/**
 * Lists pending receipt-outbox rows across every tenant.
 *
 * The outbox is tenant-scoped by row-level security, but the worker that drains
 * it has no tenant to scan with. Rather than widen the application role's access
 * to `sms_log`, the only way in is the `SECURITY DEFINER` function created by
 * migration 0007, which returns tenant and message ids and nothing else
 * (ADR 0016, ADR 0020).
 *
 * The caller opens a normal tenant-scoped transaction per ref to claim and
 * deliver it, so no message content is ever read outside its tenant.
 */
export async function listPendingSms(
  db: Kysely<Database>,
  limit: number,
): Promise<readonly PendingSmsRef[]> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role ${sql.raw(APP_ROLE)}`.execute(trx);
    // The message ids are returned by the `SECURITY DEFINER` function as `sms`
    // (single-lowercase) because the CamelCasePlugin renames result keys, but the
    // type of `PendingSmsRef` uses camelCase. Cast at the boundary.
    const result =
      await sql`select tenant_id as tenant, sms_id as sms from list_pending_sms(${limit})`.execute(
        trx,
      );
    const rows = result.rows as Record<string, unknown>[];

    return rows.map((row) => ({
      tenantId: String(row["tenant"]),
      smsId: String(row["sms"]),
    }));
  });
}
