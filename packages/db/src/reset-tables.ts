/**
 * Which tables a demo reset may truncate.
 *
 * Kysely's bookkeeping is the schema's own record that every migration has run;
 * truncating it would make the next `migrate up` try to create tables that
 * already exist. Everything else in `public` is application data.
 */
export const KEPT_TABLES: readonly string[] = ["kysely_migration", "kysely_migration_lock"];

export function isDataTable(name: string): boolean {
  return !KEPT_TABLES.includes(name);
}
