import path from "node:path";
import { sql } from "kysely";
import { createDb } from "../connection.js";
import { loadRootEnv, requireEnv } from "../env.js";
import { isDataTable } from "../reset-tables.js";

/**
 * Wipes the demo data and leaves a deployable, empty tenant list.
 *
 * This is the "present it to the state authority tomorrow" reset: every row in
 * the application's tables goes, the schema and its migrations stay, and the
 * next visit to the dashboard opens the first-run wizard again because
 * `isSetupRequired` is simply "no tenants".
 *
 * What it deliberately does **not** do:
 *
 * - drop or recreate the schema, or touch roles and grants (`tpirs_app`, RLS
 *   policies and the `anon`/`authenticated` grants are migration-owned and
 *   expensive to get wrong on Supabase);
 * - truncate `kysely_migration` / `kysely_migration_lock`, because those are the
 *   record that the schema is current — wiping them would make the next
 *   `migrate up` try to create tables that already exist;
 * - touch Supabase's own schemas (`auth`, `storage`); the app keeps its data in
 *   `public` only.
 *
 * Safe by construction: without `--yes` it prints what it would remove and
 * exits. The truncate runs in one transaction, so a failure leaves the database
 * as it was.
 */
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
loadRootEnv(repoRoot);

const connectionString = requireEnv("DATABASE_URL");
const db = createDb({ connectionString });

function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port === "" ? "5432" : parsed.port}${parsed.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes("--yes");
  const tables = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' order by tablename
  `.execute(db);
  const names = tables.rows.map((row) => row.tablename).filter(isDataTable);

  const tenants = await sql<{ count: string }>`select count(*)::text as count from tenants`.execute(
    db,
  );
  const users = await sql<{ count: string }>`select count(*)::text as count from users`.execute(db);
  const assets = await sql<{ count: string }>`select count(*)::text as count from assets`.execute(
    db,
  );

  console.log(`Target: ${describeTarget(connectionString)}`);
  console.log(
    `Current data: ${tenants.rows[0]?.count ?? "?"} tenants, ${users.rows[0]?.count ?? "?"} users, ${assets.rows[0]?.count ?? "?"} assets`,
  );
  console.log(`Tables to truncate (${String(names.length)}): ${names.join(", ")}`);

  if (!confirmed) {
    console.log("");
    console.log("Nothing was changed. Re-run with --yes to wipe these tables.");
    return;
  }

  await db.transaction().execute(async (tx) => {
    // One statement, built in SQL so identifiers are quoted by Postgres rather
    // than concatenated here. `cascade` follows the foreign keys into any table
    // the list somehow misses.
    await sql`
      do $$
      declare t text;
      begin
        for t in
          select tablename from pg_tables
          where schemaname = 'public'
            and tablename not in ('kysely_migration', 'kysely_migration_lock')
        loop
          execute format('truncate table public.%I cascade', t);
        end loop;
      end $$;
    `.execute(tx);
    // Short codes are drawn from a standalone sequence (migration 0016), so a
    // truncate does not reset it; a demo should start at the first code.
    await sql`alter sequence if exists asset_short_code_seq restart with 1000`.execute(tx);
  });

  console.log("");
  console.log("Wiped. The schema and its migration record are intact.");
  console.log("Next: open the dashboard — it shows the first-run wizard (needs SETUP_TOKEN).");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
