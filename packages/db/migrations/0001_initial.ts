import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists pgcrypto`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop extension if exists pgcrypto`.execute(db);
}
