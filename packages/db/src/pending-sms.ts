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
    // The camel-case plugin renames result keys, so keep the aliases single
    // lowercase words: `tenant_id` would arrive as `tenantId`.
    const result = await sql<{ tenant: string; sms: string }>`
      select tenant_id as tenant, sms_id as sms from list_pending_sms(${limit})
    `.execute(trx);
    return result.rows.map((row) => ({ tenantId: row.tenant, smsId: row.sms }));
  });
}
