import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/** Phase 0 has no application schema yet; tables are added by migrations from Phase 1. */
export type Database = Record<string, never>;

export interface DbOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

/**
 * Kysely types come from table interfaces; repositories define those locally and
 * cast the db handle, so the factory returns the widest safe type.
 */
export type AnyDb = Kysely<Record<string, never>>;

export function createDb(options: DbOptions): AnyDb {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
