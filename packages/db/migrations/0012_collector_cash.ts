import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 7: collector cash wallet.
 *
 * Five new tables, each with one job:
 *
 * - `collector_wallets` holds wallet state only; the balance is derived from
 *   `COLLECTOR_CASH` ledger entries (ADR 0031).
 * - `collector_deposit_instructions` maps a long-lived provider reference to
 *   one collector, and is resolved in webhook intake *before* the asset
 *   instruction table so a deposit can never be credit to an asset (ADR 0032).
 * - `cash_intakes` is the counter record for cash taken at the roadside, keyed
 *   by a client-generated reference so a retried request cannot take cash
 *   twice. The day it settles is paid through the ordinary settlement path.
 * - `cash_deposits` records money that came back from a collector, with its
 *   match state; unmatched or over-contributing deposits stay in suspense (D35).
 * - `cash_deposit_allocations` records which intakes one deposit cleared, so
 *   the deadline sweeper and reconciliation read one answer.
 *
 * Ledger entries gain `collector_user_id` so `COLLECTOR_CASH` balances are
 * attributable per collector; the column is nullable and every existing row and
 * gateway posting is untouched. `sms_log` gains `cash_intake_id` and a
 * `cash_receipt` kind so a receipt is recorded for the intake rather than for a
 * payment that never happened.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Cash postings carry the collector they belong to. Nullable, so only cash
  // postings write it and the immutability trigger on the ledger is unaffected.
  await sql`alter table ledger_entries add column collector_user_id uuid references users(id)`.execute(
    db,
  );
  await sql`create index ledger_entries_collector_idx on ledger_entries (tenant_id, collector_user_id)`.execute(
    db,
  );

  // Built-in roles gain the cash permissions (ADR 0031). Roles are inserted
  // once, so the migration has to grant them to existing role rows; roles
  // seeded after this migration pick them up from SYSTEM_ROLES.
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, p.permission
    from (values
      ('collector', 'cash:read'),
      ('collector', 'cash:intake'),
      ('zone_supervisor', 'cash:read'),
      ('zone_supervisor', 'cash:freeze'),
      ('finance_admin', 'cash:read'),
      ('finance_admin', 'cash:intake'),
      ('finance_admin', 'cash:deposit:read'),
      ('finance_admin', 'cash:deposit:match'),
      ('finance_admin', 'cash:freeze'),
      ('finance_admin', 'cash:unfreeze'),
      ('auditor', 'cash:read'),
      ('auditor', 'cash:deposit:read')
    ) as p(role_key, permission)
    join roles r on r.key = p.role_key
    where not exists (
      select 1 from role_permissions rp
      where rp.role_id = r.id and rp.permission = p.permission
    )
  `.execute(db);

  await sql`alter type sms_kind add value 'cash_receipt'`.execute(db);

  await sql`
    create table collector_wallets (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      collector_user_id uuid not null references users(id),
      status text not null default 'active' check (status in ('active', 'frozen')),
      frozen_at timestamptz,
      frozen_reason text,
      overdue_since timestamptz,
      float_ceiling_minor bigint check (float_ceiling_minor is null or float_ceiling_minor > 0),
      deposit_instruction_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, collector_user_id)
    )
  `.execute(db);
  await sql`create index collector_wallets_tenant_idx on collector_wallets (tenant_id, status)`.execute(
    db,
  );

  await sql`
    create table collector_deposit_instructions (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      collector_user_id uuid not null references users(id),
      provider text not null,
      reference text not null,
      kind text not null check (kind in ('virtual_account', 'narration')),
      status text not null default 'active' check (status in ('active', 'revoked')),
      created_at timestamptz not null default now(),
      revoked_at timestamptz,
      unique (tenant_id, provider, reference)
    )
  `.execute(db);
  await sql`create index collector_deposit_instructions_tenant_idx on collector_deposit_instructions (tenant_id, collector_user_id)`.execute(
    db,
  );
  // One active instruction per collector and provider; revoking one frees the
  // slot so a replacement can be provisioned.
  await sql`
    create unique index collector_deposit_instructions_active_idx
      on collector_deposit_instructions (tenant_id, collector_user_id, provider)
      where status = 'active'
  `.execute(db);

  await sql`
    create table cash_intakes (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      collector_user_id uuid not null references users(id),
      client_reference text not null,
      asset_id uuid not null references assets(id),
      zone_id uuid,
      obligation_period_id uuid references obligation_periods(id),
      business_date date not null,
      amount_minor bigint not null check (amount_minor > 0),
      currency text not null,
      status text not null default 'open' check (status in ('open', 'matched', 'reversed')),
      transaction_id uuid references transactions(id),
      receipt_number text not null,
      recorded_at timestamptz not null default now(),
      unique (tenant_id, collector_user_id, client_reference),
      unique (tenant_id, receipt_number)
    )
  `.execute(db);
  await sql`create index cash_intakes_tenant_recorded_idx on cash_intakes (tenant_id, collector_user_id, recorded_at desc)`.execute(
    db,
  );
  await sql`create index cash_intakes_tenant_zone_idx on cash_intakes (tenant_id, zone_id, recorded_at desc)`.execute(
    db,
  );
  await sql`create index cash_intakes_open_idx on cash_intakes (tenant_id, collector_user_id, recorded_at asc) where status = 'open'`.execute(
    db,
  );

  await sql`
    create table cash_deposits (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      collector_user_id uuid references users(id),
      provider text not null,
      provider_reference text not null,
      amount_minor bigint not null check (amount_minor > 0),
      currency text not null,
      status text not null default 'suspense' check (status in ('matched', 'partial', 'suspense')),
      webhook_event_id uuid references webhook_events(id),
      created_at timestamptz not null default now(),
      matched_at timestamptz,
      unique (tenant_id, provider, provider_reference)
    )
  `.execute(db);
  await sql`create index cash_deposits_tenant_created_idx on cash_deposits (tenant_id, created_at desc)`.execute(
    db,
  );

  await sql`
    create table cash_deposit_allocations (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      deposit_id uuid not null references cash_deposits(id),
      intake_id uuid not null references cash_intakes(id),
      amount_minor bigint not null check (amount_minor > 0),
      created_at timestamptz not null default now(),
      unique (deposit_id, intake_id)
    )
  `.execute(db);
  await sql`create index cash_deposit_allocations_tenant_idx on cash_deposit_allocations (tenant_id, deposit_id)`.execute(
    db,
  );

  // A cash receipt is recorded against the intake that produced it, so
  // `sms_log` gains a third subject type alongside payments and periods.
  await sql`alter table sms_log add column cash_intake_id uuid references cash_intakes(id)`.execute(
    db,
  );
  await sql`alter table sms_log drop constraint sms_log_has_a_subject`.execute(db);
  await sql`
    alter table sms_log add constraint sms_log_has_a_subject check (
      payment_id is not null or obligation_period_id is not null or cash_intake_id is not null
    )
  `.execute(db);
  await sql`
    create unique index sms_log_cash_intake_kind_idx
      on sms_log (cash_intake_id, kind)
      where cash_intake_id is not null
  `.execute(db);

  // The existing receipt immutability trigger grows the new subject column; the
  // definition is replaced while the trigger stays as migration 0006 created it.
  await sql`
    create or replace function reject_sms_log_content_mutation() returns trigger as $$
    begin
      if NEW.kind <> OLD.kind
        or NEW.recipient <> OLD.recipient
        or NEW.body <> OLD.body
        or NEW.payment_id is distinct from OLD.payment_id
        or NEW.obligation_period_id is distinct from OLD.obligation_period_id
        or NEW.cash_intake_id is distinct from OLD.cash_intake_id
      then
        raise exception 'sms_log content is immutable once enqueued';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);

  // An intake's money identity is written once; delivery of the day's payment
  // and deposit matching may only move it between lifecycle states.
  await sql`
    create function reject_cash_intake_money_mutation() returns trigger as $$
    begin
      if NEW.amount_minor <> OLD.amount_minor
        or NEW.currency <> OLD.currency
        or NEW.collector_user_id is distinct from OLD.collector_user_id
        or NEW.client_reference <> OLD.client_reference
        or NEW.asset_id is distinct from OLD.asset_id
        or NEW.zone_id is distinct from OLD.zone_id
        or NEW.business_date is distinct from OLD.business_date
        or NEW.receipt_number <> OLD.receipt_number
      then
        raise exception 'cash intake money identity is immutable';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger cash_intake_money_immutable
      before update on cash_intakes
      for each row execute function reject_cash_intake_money_mutation()
  `.execute(db);

  // The same rule for deposits: the amount and the reference are facts about
  // the bank event; matching only changes the collector and the state.
  await sql`
    create function reject_cash_deposit_money_mutation() returns trigger as $$
    begin
      if NEW.amount_minor <> OLD.amount_minor
        or NEW.currency <> OLD.currency
        or NEW.provider <> OLD.provider
        or NEW.provider_reference <> OLD.provider_reference
      then
        raise exception 'cash deposit money identity is immutable';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger cash_deposit_money_immutable
      before update on cash_deposits
      for each row execute function reject_cash_deposit_money_mutation()
  `.execute(db);
  await sql`
    create function reject_cash_deposit_allocation_mutation() returns trigger as $$
    begin
      raise exception 'cash deposit allocations are append-only';
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger cash_deposit_allocation_immutable
      before update or delete on cash_deposit_allocations
      for each row execute function reject_cash_deposit_allocation_mutation()
  `.execute(db);

  const tenantTables = [
    "collector_wallets",
    "collector_deposit_instructions",
    "cash_intakes",
    "cash_deposits",
    "cash_deposit_allocations",
  ];
  for (const table of tenantTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`
      create policy ${sql.raw(`tenant_isolation_${table}`)} on ${sql.table(table)}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `.execute(db);
  }

  await sql`
    grant select, insert, update
    on collector_wallets, collector_deposit_instructions, cash_intakes, cash_deposits, cash_deposit_allocations
    to tpirs_app
  `.execute(db);
  await sql`revoke delete on cash_intakes, cash_deposits, cash_deposit_allocations from tpirs_app`.execute(
    db,
  );
  await sql`grant execute on function reject_sms_log_content_mutation() to tpirs_app`.execute(db);
  await sql`grant execute on function reject_cash_intake_money_mutation() to tpirs_app`.execute(db);
  await sql`grant execute on function reject_cash_deposit_money_mutation() to tpirs_app`.execute(
    db,
  );
  await sql`grant execute on function reject_cash_deposit_allocation_mutation() to tpirs_app`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore the original SMS receipt guard before dropping the column it reads.
  await sql`
    create or replace function reject_sms_log_content_mutation() returns trigger as $$
    begin
      if NEW.kind <> OLD.kind
        or NEW.recipient <> OLD.recipient
        or NEW.body <> OLD.body
        or NEW.payment_id is distinct from OLD.payment_id
        or NEW.obligation_period_id is distinct from OLD.obligation_period_id
      then
        raise exception 'sms_log content is immutable once enqueued';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`drop trigger if exists cash_intake_money_immutable on cash_intakes`.execute(db);
  await sql`drop function if exists reject_cash_intake_money_mutation()`.execute(db);
  await sql`drop trigger if exists cash_deposit_money_immutable on cash_deposits`.execute(db);
  await sql`drop function if exists reject_cash_deposit_money_mutation()`.execute(db);
  await sql`drop trigger if exists cash_deposit_allocation_immutable on cash_deposit_allocations`.execute(
    db,
  );
  await sql`drop function if exists reject_cash_deposit_allocation_mutation()`.execute(db);

  await sql`drop index if exists sms_log_cash_intake_kind_idx`.execute(db);
  await sql`alter table sms_log drop constraint if exists sms_log_has_a_subject`.execute(db);
  await sql`
    alter table sms_log add constraint sms_log_has_a_subject check (
      payment_id is not null or obligation_period_id is not null
    )
  `.execute(db);
  await sql`alter table sms_log drop column if exists cash_intake_id`.execute(db);

  await sql`drop table if exists cash_deposit_allocations cascade`.execute(db);
  await sql`drop table if exists cash_deposits cascade`.execute(db);
  await sql`drop table if exists cash_intakes cascade`.execute(db);
  await sql`drop table if exists collector_deposit_instructions cascade`.execute(db);
  await sql`drop table if exists collector_wallets cascade`.execute(db);

  await sql`drop index if exists ledger_entries_collector_idx`.execute(db);
  await sql`alter table ledger_entries drop column if exists collector_user_id`.execute(db);

  // Remove the backfilled grants. Views like `scan:read` are grant-only rows,
  // so deleting them is exact and leaves no permission drift.
  await sql`
    delete from role_permissions rp
    using (values
      ('collector', 'cash:read'),
      ('collector', 'cash:intake'),
      ('zone_supervisor', 'cash:read'),
      ('zone_supervisor', 'cash:freeze'),
      ('finance_admin', 'cash:read'),
      ('finance_admin', 'cash:intake'),
      ('finance_admin', 'cash:deposit:read'),
      ('finance_admin', 'cash:deposit:match'),
      ('finance_admin', 'cash:freeze'),
      ('finance_admin', 'cash:unfreeze'),
      ('auditor', 'cash:read'),
      ('auditor', 'cash:deposit:read')
    ) as p(role_key, permission),
    roles r
    where r.key = p.role_key
      and rp.role_id = r.id
      and rp.permission = p.permission
  `.execute(db);

  // The enum keeps the value (Postgres cannot drop one without recreating the
  // type) and migration 0006's down() drops the whole type, so rollback to zero
  // still reaches a clean state.
}
