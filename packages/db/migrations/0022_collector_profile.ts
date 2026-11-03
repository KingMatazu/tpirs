import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Contact and identity details for the staff who handle cash.
 *
 * A collector takes money from drivers on the street, so the state needs a way to
 * reach them and a way to know who is holding its cash. These are the three
 * things a levy office actually records for that: a phone number, a national
 * identification number and a home address.
 *
 * All three are nullable on purpose. This table also holds officers, finance
 * users and auditors, who have no collector profile, and the demo seed's staff
 * predate the fields. The API requires them only for an account that carries the
 * collector role, which is a rule about people, not about the table.
 *
 * No check constraint encodes the ID's shape. A national identification number is
 * the state's own format, and the tenant's `collectors.nationalIdPattern` decides
 * it — a state with a nine-digit number must not need a migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table users add column phone text`.execute(db);
  await sql`alter table users add column national_id text`.execute(db);
  await sql`alter table users add column home_address text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table users drop column if exists home_address`.execute(db);
  await sql`alter table users drop column if exists national_id`.execute(db);
  await sql`alter table users drop column if exists phone`.execute(db);
}
