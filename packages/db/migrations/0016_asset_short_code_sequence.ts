import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 10 follow-up: a human-typable short code.
 *
 * `shortCodeFormat` fills `{id}` from this sequence. Before it, the service used
 * the asset's random 32-character opaque id, so a registered vehicle came out as
 * `B096f9f28cffb495699fddb74055190e7` — a driver cannot quote that over USSD, and
 * it defeats the point of a short code. The demo seed hid it by writing `B000001`
 * directly.
 *
 * The sequence starts above the seeded demo range so a fresh deployment does not
 * collide with `B000001`; a collision would be caught by the unique constraint on
 * `(tenant_id, short_code)` anyway.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create sequence if not exists asset_short_code_seq start with 1000`.execute(db);
  // The application role writes assets; without this it cannot draw a number.
  await sql`grant usage, select on sequence asset_short_code_seq to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke all on sequence asset_short_code_seq from tpirs_app`.execute(db);
  await sql`drop sequence if exists asset_short_code_seq`.execute(db);
}
