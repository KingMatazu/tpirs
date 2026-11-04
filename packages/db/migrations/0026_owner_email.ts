import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * An owner's email address, optional.
 *
 * The dashboard now registers a driver from four fields: full name, phone, plate
 * and an optional email. The first three already existed; the email had nowhere
 * to live, and the alternative — putting a contact address into the asset's
 * free-form attributes — would make it invisible to search and unvalidated.
 *
 * Nullable, and never required: a driver pays by USSD or SMS with the short code
 * on their sticker, so an address is a convenience for the state, not a way to
 * reach the person. Nothing sends to it yet.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table owners add column email text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table owners drop column if exists email`.execute(db);
}
