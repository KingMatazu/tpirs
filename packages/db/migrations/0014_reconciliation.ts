import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 8: settlement import, reconciliation runs, exceptions and anomalies.
 *
 * Five tables, each with one job:
 *
 * - `settlement_imports` is one statement file, identified by a hash of its
 *   bytes, so re-uploading it is a no-op (ADR 0035).
 * - `settlement_rows` is one normalised line of a statement, identified inside
 *   its import by a hash of the normalised fields. It is evidence, not a
 *   payment: it carries `payment_id` only once matched.
 * - `reconciliation_runs` is one attempt at one business day, versioned by
 *   `run_seq` and append-only (ADR 0037). Sign-off is the only transition a
 *   completed run allows.
 * - `reconciliation_exceptions` is one open condition, carried forward across
 *   runs by `dedupe_key` instead of being duplicated per day.
 * - `anomaly_events` is one statistical observation, deduplicated per rule,
 *   subject and window (ADR 0039).
 *
 * The ledger gains a `gateway_fees` account type so a matched settlement can
 * post the gateway's cut as a cost of collection rather than leaving
 * `GATEWAY_CLEARING` permanently overstated (ADR 0036). The account row itself
 * is created lazily by `ensureStandardAccounts`, so no tenant data is rewritten
 * here.
 */

const TENANT_TABLES = [
  "settlement_imports",
  "settlement_rows",
  "reconciliation_runs",
  "reconciliation_exceptions",
  "anomaly_events",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // Postgres can add an enum value in a transaction, but the value cannot be
  // used until the transaction commits. Nothing in this migration writes an
  // account row, so the guard does not apply (the repository does that later).
  await sql`alter type account_type add value if not exists 'gateway_fees'`.execute(db);
  // Fees are a cost of collection, not a reduction of revenue: the chart needs
  // an expense class alongside asset/liability/revenue (ADR 0036).
  await sql`alter type account_class add value if not exists 'expense'`.execute(db);

  await sql`
    create table settlement_imports (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      provider text not null,
      source text not null default 'statement' check (source in ('statement', 'api')),
      filename text not null,
      file_hash text not null,
      period_start date,
      period_end date,
      row_count integer not null default 0 check (row_count >= 0),
      rejected_count integer not null default 0 check (rejected_count >= 0),
      imported_by_user_id uuid references users(id),
      imported_at timestamptz not null default now(),
      status text not null default 'imported' check (status in ('imported', 'failed')),
      unique (tenant_id, provider, file_hash)
    )
  `.execute(db);
  await sql`create index settlement_imports_period_idx on settlement_imports (tenant_id, period_start, period_end)`.execute(
    db,
  );

  await sql`
    create table settlement_rows (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      import_id uuid not null references settlement_imports(id),
      row_number integer not null check (row_number > 0),
      row_hash text not null,
      provider_reference text not null,
      amount_minor bigint not null check (amount_minor >= 0),
      fee_minor bigint not null default 0 check (fee_minor >= 0),
      currency text not null check (char_length(currency) = 3),
      settled_at timestamptz not null,
      description text,
      raw jsonb not null default '{}'::jsonb,
      payment_id uuid references payments(id),
      transaction_id uuid references transactions(id),
      status text not null default 'unmatched'
        check (status in ('unmatched', 'matched', 'posted', 'excluded')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, import_id, row_hash)
    )
  `.execute(db);
  await sql`create index settlement_rows_reference_idx on settlement_rows (tenant_id, provider_reference)`.execute(
    db,
  );
  await sql`create index settlement_rows_status_idx on settlement_rows (tenant_id, status)`.execute(
    db,
  );
  await sql`create index settlement_rows_settled_idx on settlement_rows (tenant_id, settled_at)`.execute(
    db,
  );

  await sql`
    create table reconciliation_runs (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      business_date date not null,
      run_seq integer not null check (run_seq > 0),
      status text not null default 'running'
        check (status in ('running', 'completed', 'failed', 'signed_off')),
      checklist jsonb not null default '[]'::jsonb,
      tolerance_snapshot bigint not null,
      fee_tolerance_snapshot bigint not null,
      exception_count integer not null default 0 check (exception_count >= 0),
      started_at timestamptz not null default now(),
      completed_at timestamptz,
      failure_reason text,
      signed_off_by_user_id uuid references users(id),
      signed_off_at timestamptz,
      sign_off_note text,
      unique (tenant_id, business_date, run_seq)
    )
  `.execute(db);
  await sql`create index reconciliation_runs_date_idx on reconciliation_runs (tenant_id, business_date desc)`.execute(
    db,
  );

  await sql`
    create table reconciliation_exceptions (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      run_id uuid not null references reconciliation_runs(id),
      dedupe_key text not null,
      kind text not null,
      severity text not null check (severity in ('blocking', 'warning', 'info')),
      subject_type text not null,
      subject_id text not null default '',
      expected_minor bigint,
      actual_minor bigint,
      difference_minor bigint,
      currency text,
      business_date date not null,
      detail jsonb not null default '{}'::jsonb,
      first_seen_run_id uuid not null references reconciliation_runs(id),
      last_seen_run_id uuid not null references reconciliation_runs(id),
      status text not null default 'open' check (status in ('open', 'resolved', 'waived')),
      resolution_note text,
      resolved_by_user_id uuid references users(id),
      resolved_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  // One row per *open* condition. A condition that reappears after being
  // resolved is a new row, so closing something stays a recorded fact (D43).
  await sql`
    create unique index reconciliation_exceptions_open_idx
      on reconciliation_exceptions (tenant_id, dedupe_key)
      where status = 'open'
  `.execute(db);
  await sql`create index reconciliation_exceptions_queue_idx on reconciliation_exceptions (tenant_id, status, severity)`.execute(
    db,
  );
  await sql`create index reconciliation_exceptions_run_idx on reconciliation_exceptions (tenant_id, run_id)`.execute(
    db,
  );

  await sql`
    create table anomaly_events (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      rule_key text not null,
      subject_type text not null,
      subject_id text not null default '',
      window_start date not null,
      window_end date not null,
      observed numeric(18, 4) not null,
      baseline numeric(18, 4) not null,
      threshold numeric(18, 4) not null,
      severity text not null check (severity in ('warning', 'info')),
      detail jsonb not null default '{}'::jsonb,
      status text not null default 'open' check (status in ('open', 'acknowledged')),
      acknowledged_by_user_id uuid references users(id),
      acknowledged_at timestamptz,
      created_at timestamptz not null default now(),
      unique (tenant_id, rule_key, subject_type, subject_id, window_end),
      check (window_end >= window_start)
    )
  `.execute(db);
  await sql`create index anomaly_events_queue_idx on anomaly_events (tenant_id, status, created_at desc)`.execute(
    db,
  );

  // A run is a record of an attempt: only the sign-off columns may change once
  // it leaves `running`, and nothing may be deleted (ADR 0037).
  await sql`
    create function reconciliation_runs_guard() returns trigger as $$
    begin
      if TG_OP = 'DELETE' then
        raise exception 'reconciliation runs are append-only';
      end if;
      if NEW.tenant_id <> OLD.tenant_id
        or NEW.business_date <> OLD.business_date
        or NEW.run_seq <> OLD.run_seq
        or NEW.started_at <> OLD.started_at then
        raise exception 'a reconciliation run identity is immutable';
      end if;
      if OLD.status = 'signed_off' then
        raise exception 'a signed-off reconciliation run is immutable';
      end if;
      if OLD.status <> 'running' then
        if NEW.status is distinct from OLD.status
          and not (OLD.status = 'completed' and NEW.status = 'signed_off') then
          raise exception 'a completed reconciliation run may only be signed off';
        end if;
        if NEW.checklist is distinct from OLD.checklist
          or NEW.tolerance_snapshot is distinct from OLD.tolerance_snapshot
          or NEW.fee_tolerance_snapshot is distinct from OLD.fee_tolerance_snapshot
          or NEW.exception_count is distinct from OLD.exception_count
          or NEW.completed_at is distinct from OLD.completed_at
          or NEW.failure_reason is distinct from OLD.failure_reason then
          raise exception 'a completed reconciliation run is immutable';
        end if;
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger reconciliation_runs_guard
      before update or delete on reconciliation_runs
      for each row execute function reconciliation_runs_guard()
  `.execute(db);

  // A statement row is evidence. Matching may set `payment_id` and move
  // `status`, but the money it recorded can never be rewritten (ADR 0035).
  await sql`
    create function reject_settlement_row_mutation() returns trigger as $$
    begin
      if NEW.tenant_id <> OLD.tenant_id
        or NEW.import_id <> OLD.import_id
        or NEW.row_number <> OLD.row_number
        or NEW.row_hash <> OLD.row_hash
        or NEW.provider_reference <> OLD.provider_reference
        or NEW.amount_minor <> OLD.amount_minor
        or NEW.fee_minor <> OLD.fee_minor
        or NEW.currency <> OLD.currency
        or NEW.settled_at <> OLD.settled_at then
        raise exception 'settlement row evidence is immutable';
      end if;
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger settlement_row_evidence_immutable
      before update on settlement_rows
      for each row execute function reject_settlement_row_mutation()
  `.execute(db);

  for (const table of TENANT_TABLES) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`
      create policy ${sql.raw(`tenant_isolation_${table}`)} on ${sql.table(table)}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `.execute(db);
  }

  await sql`
    grant select, insert, update
    on settlement_imports, settlement_rows, reconciliation_runs, reconciliation_exceptions, anomaly_events
    to tpirs_app
  `.execute(db);
  await sql`
    revoke delete
    on settlement_imports, settlement_rows, reconciliation_runs, reconciliation_exceptions, anomaly_events
    from tpirs_app
  `.execute(db);
  await sql`grant execute on function reconciliation_runs_guard() to tpirs_app`.execute(db);
  await sql`grant execute on function reject_settlement_row_mutation() to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists reconciliation_runs_guard on reconciliation_runs`.execute(db);
  await sql`drop function if exists reconciliation_runs_guard() cascade`.execute(db);
  await sql`drop function if exists reject_settlement_row_mutation() cascade`.execute(db);

  // Child tables first: rows reference imports, exceptions reference runs.
  await sql`drop table if exists anomaly_events`.execute(db);
  await sql`drop table if exists reconciliation_exceptions`.execute(db);
  await sql`drop table if exists settlement_rows`.execute(db);
  await sql`drop table if exists reconciliation_runs`.execute(db);
  await sql`drop table if exists settlement_imports`.execute(db);

  // Postgres cannot remove one enum value, so the type is rebuilt. Any account
  // already provisioned with the new type must be gone first: dropping the
  // value under a live account would silently change its meaning.
  await sql`
    do $$
    begin
      if exists (select 1 from accounts where account_type::text = 'gateway_fees') then
        raise exception 'cannot remove account_type.gateway_fees while gateway_fees accounts exist';
      end if;
    end
    $$
  `.execute(db);
  await sql`alter table accounts alter column account_type type text`.execute(db);
  await sql`drop type account_type`.execute(db);
  await sql`
    create type account_type as enum (
      'asset_wallet',
      'revenue_levy',
      'gateway_clearing',
      'settlement_bank',
      'suspense',
      'collector_cash'
    )
  `.execute(db);
  await sql`alter table accounts alter column account_type type account_type using account_type::account_type`.execute(
    db,
  );

  // The expense class is removed the same way, for the same reason.
  await sql`
    do $$
    begin
      if exists (select 1 from accounts where account_class::text = 'expense') then
        raise exception 'cannot remove account_class.expense while expense accounts exist';
      end if;
    end
    $$
  `.execute(db);
  await sql`alter table accounts alter column account_class type text`.execute(db);
  await sql`drop type account_class`.execute(db);
  await sql`
    create type account_class as enum ('asset', 'liability', 'revenue')
  `.execute(db);
  await sql`alter table accounts alter column account_class type account_class using account_class::account_class`.execute(
    db,
  );
}
