import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * A collector's deposit destination can be a Virtual Terminal (ADR 0069).
 *
 * The terminal is a gateway object that outlives the row: the collector
 * transfers to the dedicated NUBAN it issues, and the webhook names the terminal
 * code. `reference` therefore holds the code (`VT_…`), and the display details
 * the app needs — account number, account name, bank, page URL — go in
 * `details`, because they vary by market and may be absent.
 *
 * Nothing else changes: `status`/`revoked_at` already model rotation, and
 * `cash_deposits` is keyed by the webhook event (migration 0013), so a collector
 * may deposit to the same terminal any number of times.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table collector_deposit_instructions
      drop constraint collector_deposit_instructions_kind_check
  `.execute(db);
  await sql`
    alter table collector_deposit_instructions
      add constraint collector_deposit_instructions_kind_check
      check (kind in ('virtual_account', 'narration', 'virtual_terminal'))
  `.execute(db);
  await sql`
    alter table collector_deposit_instructions
      add column details jsonb not null default '{}'::jsonb
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The old schema cannot represent a terminal destination: a terminal row has
  // no account number of its own and would be unreadable to the previous code.
  // The migration check runs this on an empty database; a database that has real
  // terminals keeps its deposits, because `cash_deposits` does not reference the
  // instruction.
  await sql`
    delete from collector_deposit_instructions where kind = 'virtual_terminal'
  `.execute(db);
  await sql`
    alter table collector_deposit_instructions
      drop constraint collector_deposit_instructions_kind_check
  `.execute(db);
  await sql`
    alter table collector_deposit_instructions
      add constraint collector_deposit_instructions_kind_check
      check (kind in ('virtual_account', 'narration'))
  `.execute(db);
  await sql`alter table collector_deposit_instructions drop column details`.execute(db);
}
