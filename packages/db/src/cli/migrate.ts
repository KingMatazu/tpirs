import path from "node:path";
import { createDb } from "../connection.js";
import { checkMigrations, createMigrator, migrateDown, migrateUp } from "../migrator.js";
import { loadRootEnv, requireEnv } from "../env.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../migrations");
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

loadRootEnv(repoRoot);
const connectionString = requireEnv("DATABASE_URL");
const db = createDb({ connectionString });

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "up":
      await migrateUp(db, migrationsDir);
      console.log("Migrations applied");
      break;
    case "down":
      await migrateDown(db, migrationsDir);
      console.log("Rolled back one migration");
      break;
    case "status": {
      const migrator = createMigrator(db, migrationsDir);
      const status = await migrator.getMigrations();
      for (const migration of status) {
        console.log(
          `${migration.name}: ${migration.executedAt === undefined ? "pending" : "applied"}`,
        );
      }
      break;
    }
    case "check":
      await checkMigrations(db, migrationsDir);
      console.log("Migration check passed: all migrations apply and roll back cleanly");
      break;
    default:
      console.error("Usage: migrate <up|down|status|check>");
      process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
