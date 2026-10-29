import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Migrator, NO_MIGRATIONS, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely";
import type { AnyDb } from "./connection.js";

/**
 * Loads migrations from .ts files so they run under tsx in every environment
 * (Kysely's FileMigrationProvider only picks up compiled .js).
 */
export class TsFileMigrationProvider implements MigrationProvider {
  readonly #migrationDir: string;

  constructor(migrationDir: string) {
    this.#migrationDir = migrationDir;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.#migrationDir))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const mod = (await import(pathToFileURL(path.join(this.#migrationDir, file)).href)) as {
        up: Migration["up"];
        down: Migration["down"];
      };
      const name = file.slice(0, -3);
      if (typeof mod.down === "function") {
        migrations[name] = { up: mod.up, down: mod.down };
      } else {
        migrations[name] = { up: mod.up };
      }
    }
    return migrations;
  }
}

export function createMigrator(db: AnyDb, migrationsDir: string): Migrator {
  return new Migrator({
    db,
    provider: new TsFileMigrationProvider(migrationsDir),
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A stable advisory-lock key for "tpirs migrations".
 *
 * Every DB-backed test file (and every API/worker instance at boot) calls
 * `migrateUp`; without a lock they race on the same DDL and one of them fails
 * with a duplicate relation. The lock is transaction-scoped and held for the
 * whole migration: concurrent callers wait, then find nothing to do. The
 * migrator runs on the pool, not on the lock's connection, so its own
 * per-migration transactions are unaffected.
 */
const MIGRATION_LOCK_KEY = 4_246_112_001;

/**
 * Whether every migration on disk is already recorded as applied.
 *
 * CI migrates once before the suite (`scripts/ci/integration.sh`), so this
 * short-circuits the common case to one cheap query and keeps every DB-backed
 * test file from queueing on the migration lock. A missing table or a partial
 * set returns false, and the locked path runs.
 */
async function schemaIsCurrent(db: AnyDb, migrationsDir: string): Promise<boolean> {
  try {
    // Names come from the directory, not from importing every migration: the
    // check runs in every DB-backed test's beforeAll, and importing a dozen
    // TypeScript modules there is what pushed the hook past its timeout.
    const expected = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .map((file) => file.slice(0, -3));
    const applied = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
    const names = new Set(applied.rows.map((row) => row.name));
    return expected.every((name) => names.has(name));
  } catch {
    return false;
  }
}

export async function migrateUp(db: AnyDb, migrationsDir: string): Promise<void> {
  if (await schemaIsCurrent(db, migrationsDir)) return;
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`.execute(trx);
    const migrator = createMigrator(db, migrationsDir);
    const { error } = await migrator.migrateToLatest();
    if (error) throw toError(error);
  });
}

export async function migrateDown(db: AnyDb, migrationsDir: string): Promise<void> {
  const migrator = createMigrator(db, migrationsDir);
  const { error } = await migrator.migrateDown();
  if (error) throw toError(error);
}

/** Apply every migration, then roll back to zero. Proves migrations are reversible. */
export async function checkMigrations(db: AnyDb, migrationsDir: string): Promise<void> {
  const up = createMigrator(db, migrationsDir);
  const upResult = await up.migrateToLatest();
  if (upResult.error) throw toError(upResult.error);
  if (upResult.results === undefined || upResult.results.length === 0) {
    throw new Error("Migration check found no migrations to apply");
  }
  const down = createMigrator(db, migrationsDir);
  const downResult = await down.migrateTo(NO_MIGRATIONS);
  if (downResult.error) throw toError(downResult.error);
}
