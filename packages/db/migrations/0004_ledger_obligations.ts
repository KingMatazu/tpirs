import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 3: ledger and obligations.
 *
 * Append-only double-entry ledger with chart of accounts, transactions, and
 * ledger entries. Immutability is enforced at the database level (triggers +
 * revoked privileges). Obligation periods track per-asset obligations for
 * pay_per_use and scheduled models. Reversal requests support dual approval
 * with self-approval prevention.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Account classes and types
  await sql`
    create type account_class as enum ('asset', 'liability', 'revenue')
  `.execute(db);
  await sql`
    create type account_type as enum ('asset_wallet', 'revenue_levy', 'gateway_clearing', 'settlement_bank', 'suspense', 'collector_cash')
  `.execute(db);
  await sql`
    create type ledger_direction as enum ('debit', 'credit')
  `.execute(db);
  await sql`
    create type obligation_status as enum ('unpaid', 'paid', 'waived')
  `.execute(db);
  await sql`
    create type reversal_status as enum ('pending', 'approved', 'rejected')
  `.execute(db);

  await sql`
    create table accounts (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      code text not null,
      name text not null,
      account_type account_type not null,
      account_class account_class not null,
      currency char(3) not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, code)
    )
  `.execute(db);
  await sql`create index accounts_tenant_idx on accounts (tenant_id)`.execute(db);

  await sql`
    create table transactions (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      idempotency_key text,
      source_type text not null,
      source_id text,
      description text,
      posted_at timestamptz not null default now(),
      created_by_user_id uuid references users(id),
      metadata jsonb not null default '{}'::jsonb,
      unique (tenant_id, idempotency_key)
    )
  `.execute(db);
  await sql`create index transactions_tenant_idx on transactions (tenant_id)`.execute(db);
  await sql`create index transactions_posted_idx on transactions (tenant_id, posted_at)`.execute(
    db,
  );

  await sql`
    create table ledger_entries (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      transaction_id uuid not null references transactions(id),
      account_id uuid not null references accounts(id),
      direction ledger_direction not null,
      amount_minor bigint not null check (amount_minor > 0),
      currency char(3) not null,
      asset_id uuid references assets(id),
      payment_id uuid,
      obligation_period_id uuid,
      memo text,
      posted_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index ledger_entries_tenant_idx on ledger_entries (tenant_id)`.execute(db);
  await sql`create index ledger_entries_transaction_idx on ledger_entries (transaction_id)`.execute(
    db,
  );
  await sql`create index ledger_entries_account_idx on ledger_entries (tenant_id, account_id)`.execute(
    db,
  );
  await sql`create index ledger_entries_asset_idx on ledger_entries (asset_id)`.execute(db);

  // Currency consistency: entry currency must match account currency
  await sql`
    create function check_ledger_entry_currency() returns trigger as $$
    declare
      acct_currency char(3);
    begin
      select currency into acct_currency from accounts where id = NEW.account_id;
      if acct_currency != NEW.currency then
        raise exception 'ledger entry currency must match account currency';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger ledger_entry_currency_check
      before insert or update on ledger_entries
      for each row execute function check_ledger_entry_currency()
  `.execute(db);

  await sql`
    create table obligation_periods (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      asset_id uuid not null references assets(id),
      period_key text not null,
      business_date date not null,
      status obligation_status not null default 'unpaid',
      amount_minor bigint not null check (amount_minor >= 0),
      amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),
      currency char(3) not null,
      fee_rule_key text,
      fee_amount_snapshot_minor bigint,
      paid_transaction_id uuid references transactions(id),
      priority integer not null default 0,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, asset_id, period_key)
    )
  `.execute(db);
  await sql`create index obligation_periods_tenant_idx on obligation_periods (tenant_id)`.execute(
    db,
  );
  await sql`create index obligation_periods_asset_idx on obligation_periods (asset_id)`.execute(db);
  await sql`create index obligation_periods_status_idx on obligation_periods (tenant_id, status)`.execute(
    db,
  );

  await sql`
    create table reversal_requests (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      original_transaction_id uuid not null references transactions(id),
      reason text not null,
      status reversal_status not null default 'pending',
      requested_by_user_id uuid not null references users(id),
      approved_by_user_id uuid references users(id),
      rejected_by_user_id uuid references users(id),
      approved_at timestamptz,
      rejected_at timestamptz,
      expires_at timestamptz,
      reversing_transaction_id uuid references transactions(id),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index reversal_requests_tenant_idx on reversal_requests (tenant_id)`.execute(db);
  await sql`create index reversal_requests_status_idx on reversal_requests (tenant_id, status)`.execute(
    db,
  );

  // Append-only enforcement for ledger
  await sql`
    create function reject_ledger_mutation() returns trigger as $$
    begin
      raise exception 'ledger entries and transactions are append-only';
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger transactions_no_update
      before update or delete on transactions
      for each row execute function reject_ledger_mutation()
  `.execute(db);
  await sql`
    create trigger ledger_entries_no_update
      before update or delete on ledger_entries
      for each row execute function reject_ledger_mutation()
  `.execute(db);

  // Prevent self-approval at DB level
  await sql`
    create function check_reversal_approval() returns trigger as $$
    begin
      if NEW.status = 'approved' and NEW.approved_by_user_id = NEW.requested_by_user_id then
        raise exception 'cannot approve own reversal request';
      end if;
      if NEW.status = 'approved' and NEW.approved_at is null then
        NEW.approved_at = now();
      end if;
      if NEW.status = 'rejected' and NEW.rejected_at is null then
        NEW.rejected_at = now();
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger reversal_approval_check
      before update on reversal_requests
      for each row execute function check_reversal_approval()
  `.execute(db);

  const tenantTables = [
    "accounts",
    "transactions",
    "ledger_entries",
    "obligation_periods",
    "reversal_requests",
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
    grant select, insert on accounts, transactions, ledger_entries, obligation_periods, reversal_requests
    to tpirs_app
  `.execute(db);
  await sql`revoke update, delete on transactions, ledger_entries from tpirs_app`.execute(db);
  await sql`grant update on reversal_requests to tpirs_app`.execute(db);
  await sql`grant execute on function reject_ledger_mutation() to tpirs_app`.execute(db);
  await sql`grant execute on function check_ledger_entry_currency() to tpirs_app`.execute(db);
  await sql`grant execute on function check_reversal_approval() to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists reversal_requests cascade`.execute(db);
  await sql`drop table if exists obligation_periods cascade`.execute(db);
  await sql`drop table if exists ledger_entries cascade`.execute(db);
  await sql`drop table if exists transactions cascade`.execute(db);
  await sql`drop table if exists accounts cascade`.execute(db);
  await sql`drop function if exists check_reversal_approval() cascade`.execute(db);
  await sql`drop function if exists check_ledger_entry_currency() cascade`.execute(db);
  await sql`drop function if exists reject_ledger_mutation() cascade`.execute(db);
  await sql`drop type if exists reversal_status`.execute(db);
  await sql`drop type if exists obligation_status`.execute(db);
  await sql`drop type if exists ledger_direction`.execute(db);
  await sql`drop type if exists account_type`.execute(db);
  await sql`drop type if exists account_class`.execute(db);
}
