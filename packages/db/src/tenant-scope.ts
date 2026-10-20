import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { AnyDb, Database } from "./connection.js";

/** A Kysely handle bound to one tenant with the app role active (RLS enforced). */
export type TenantTx = Transaction<Database>;

export type TenantScopeFn<T> = (tx: TenantTx) => Promise<T>;

/** The non-owner application role created by the tenancy migration. */
export const APP_ROLE = "tpirs_app";

/**
 * Runs `fn` as the application role with `app.tenant_id` set, so row-level
 * security confines every statement to one tenant. Setting the role makes RLS
 * apply even when the connecting role owns the tables (local dev / tests).
 */
export async function withTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: TenantScopeFn<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role ${sql.raw(APP_ROLE)}`.execute(trx);
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Runs `fn` with the connection's own privileges and no tenant filter. Use only
 * for provisioning and seeding, never for request handling.
 */
export async function withSystem<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(fn);
}

export type { AnyDb };
