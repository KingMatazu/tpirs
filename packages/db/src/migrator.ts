import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Migrator, NO_MIGRATIONS } from "kysely";
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

export async function migrateUp(db: AnyDb, migrationsDir: string): Promise<void> {
  const migrator = createMigrator(db, migrationsDir);
  const { error } = await migrator.migrateToLatest();
  if (error) throw toError(error);
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
