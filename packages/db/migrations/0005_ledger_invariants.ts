import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 3 hardening: database-level ledger invariants.
 *
 * Migration 0004 created the ledger but left three gaps:
 *
 * 1. `obligation_periods` was only granted SELECT and INSERT, so the service
 *    could not mark a period paid. The privilege is fixed here.
 * 2. Nothing stopped an unbalanced transaction from being committed. The
 *    balance is now asserted by a deferred constraint trigger, so the check
 *    runs once at COMMIT with the final set of entries.
 * 3. Nothing stopped a period from being marked paid for more than it owed.
 *
 * The trigger is DEFERRABLE INITIALLY DEFERRED because a transaction is
 * posted as one row per entry: the balance is only knowable after the last
 * entry is inserted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The obligation service marks periods paid, so the app role needs UPDATE.
  await sql`grant update on obligation_periods to tpirs_app`.execute(db);
  // Deleting a period would erase the record of what was owed.
  await sql`revoke delete on obligation_periods from tpirs_app`.execute(db);

  // A period can never be paid for more than it owes, and a paid period is
  // always paid in full.
  await sql`
    alter table obligation_periods
      add constraint obligation_periods_paid_within_amount
      check (amount_paid_minor <= amount_minor)
  `.execute(db);
  await sql`
    alter table obligation_periods
      add constraint obligation_periods_paid_settles_in_full
      check (status <> 'paid' or amount_paid_minor = amount_minor)
  `.execute(db);

  // Double-entry invariant, asserted by the database rather than only by the
  // application: a committed transaction has at least two entries, uses one
  // currency, and its debits equal its credits.
  await sql`
    create function check_transaction_balanced() returns trigger as $$
    declare
      target_transaction uuid;
      entry_count bigint;
      debit_total bigint;
      credit_total bigint;
      currency_count bigint;
    begin
      if tg_op = 'DELETE' then
        target_transaction := OLD.transaction_id;
      else
        target_transaction := NEW.transaction_id;
      end if;

      select
        count(*),
        coalesce(sum(case when direction = 'debit' then amount_minor else 0 end), 0),
        coalesce(sum(case when direction = 'credit' then amount_minor else 0 end), 0),
        count(distinct currency)
      into entry_count, debit_total, credit_total, currency_count
      from ledger_entries
      where transaction_id = target_transaction;

      if entry_count < 2 then
        raise exception 'ledger transaction % needs at least two entries, found %',
          target_transaction, entry_count;
      end if;
      if currency_count > 1 then
        raise exception 'ledger transaction % mixes % currencies', target_transaction, currency_count;
      end if;
      if debit_total <> credit_total then
        raise exception 'ledger transaction % is not balanced: debits % <> credits %',
          target_transaction, debit_total, credit_total;
      end if;
      return null;
    end;
    $$ language plpgsql
  `.execute(db);

  await sql`
    create constraint trigger ledger_transaction_balanced
      after insert or update or delete on ledger_entries
      deferrable initially deferred
      for each row execute function check_transaction_balanced()
  `.execute(db);

  await sql`grant execute on function check_transaction_balanced() to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists ledger_transaction_balanced on ledger_entries`.execute(db);
  await sql`drop function if exists check_transaction_balanced()`.execute(db);
  await sql`
    alter table obligation_periods
      drop constraint if exists obligation_periods_paid_settles_in_full
  `.execute(db);
  await sql`
    alter table obligation_periods
      drop constraint if exists obligation_periods_paid_within_amount
  `.execute(db);
  await sql`revoke update on obligation_periods from tpirs_app`.execute(db);
  await sql`revoke delete on obligation_periods from tpirs_app`.execute(db);
}
