import { sql } from "kysely";
import type { Kysely } from "kysely";
import { ALL_PERMISSIONS } from "@tpirs/domain";

/**
 * Phase 6: scan and dispute ingestion, plus paid-set support.
 *
 * Creates `scans` and `disputes` / `dispute_evidence` tables with tenant
 * isolation and RLS, adds indexes for the sync feed, and backfills the new
 * permissions (`scan:read`, `scan:record`, `dispute:create`) onto existing
 * built-in role rows so deploys don't require a full re-seed. Reversals are
 * made to update obligation periods so a reversed payment leaves the paid set
 * (ADR 0028).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Backfill new permissions onto existing roles (and ensure every role gets them
  // once). New roles seeded after this migration pick them up from SYSTEM_ROLES.
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, p.permission
    from roles r
    cross join (values
      ('scan:read'),
      ('scan:record'),
      ('dispute:create')
    ) as p(permission)
    where not exists (
      select 1 from role_permissions rp
      where rp.role_id = r.id and rp.permission = p.permission
    )
  `.execute(db);

  // Ensure officers/supervisors/auditors/finance can participate in the field
  // flow without changing the seed; grant read/record where sensible.
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, 'scan:read'
    from roles r
    where r.key in ('officer', 'zone_supervisor', 'finance_admin', 'auditor')
      and not exists (
        select 1 from role_permissions rp where rp.role_id = r.id and rp.permission = 'scan:read'
      )
  `.execute(db);
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, 'scan:record'
    from roles r
    where r.key in ('officer', 'zone_supervisor')
      and not exists (
        select 1 from role_permissions rp where rp.role_id = r.id and rp.permission = 'scan:record'
      )
  `.execute(db);
  await sql`
    insert into role_permissions (role_id, tenant_id, permission)
    select r.id, r.tenant_id, 'dispute:create'
    from roles r
    where r.key in ('officer', 'zone_supervisor')
      and not exists (
        select 1 from role_permissions rp where rp.role_id = r.id and rp.permission = 'dispute:create'
      )
  `.execute(db);

  await sql`
    create table scans (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      asset_id uuid not null references assets(id),
      officer_user_id uuid not null references users(id),
      device_id text not null,
      client_scan_id uuid not null,
      source text not null check (source in ('qr','manual','offline_queue')),
      observed_status text not null,
      authoritative_status text not null,
      business_date date not null,
      scanned_at timestamptz not null,
      recorded_at timestamptz not null default now(),
      latitude numeric(9,6),
      longitude numeric(9,6),
      zone_id uuid,
      unique (tenant_id, client_scan_id)
    )
  `.execute(db);
  await sql`create index scans_tenant_scanned_idx on scans (tenant_id, scanned_at desc)`.execute(
    db,
  );
  await sql`create index scans_tenant_asset_scanned_idx on scans (tenant_id, asset_id, scanned_at desc)`.execute(
    db,
  );
  await sql`create index scans_tenant_officer_scanned_idx on scans (tenant_id, officer_user_id, scanned_at desc)`.execute(
    db,
  );

  await sql`
    create table disputes (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      asset_id uuid not null references assets(id),
      opened_by_user_id uuid not null references users(id),
      zone_id uuid,
      client_dispute_id uuid not null,
      status text not null default 'open' check (status in ('open','under_review','resolved','rejected')),
      reason text not null,
      description text not null,
      occurred_at timestamptz not null,
      business_date date not null,
      recorded_at timestamptz not null default now(),
      latitude numeric(9,6),
      longitude numeric(9,6),
      resolution_note text,
      resolved_by_user_id uuid references users(id),
      resolved_at timestamptz,
      linked_payment_id uuid,
      unique (tenant_id, client_dispute_id)
    )
  `.execute(db);
  await sql`create index disputes_tenant_recorded_idx on disputes (tenant_id, recorded_at desc)`.execute(
    db,
  );
  await sql`create index disputes_tenant_asset_idx on disputes (tenant_id, asset_id)`.execute(db);
  await sql`create index disputes_tenant_opened_idx on disputes (tenant_id, opened_by_user_id)`.execute(
    db,
  );

  await sql`
    create table dispute_evidence (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      dispute_id uuid not null references disputes(id),
      object_key text not null,
      content_type text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index dispute_evidence_tenant_dispute_idx on dispute_evidence (tenant_id, dispute_id)`.execute(
    db,
  );

  const tenantTables = ["scans", "disputes", "dispute_evidence"];
  for (const table of tenantTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`
      create policy ${sql.raw(`tenant_isolation_${table}`)} on ${sql.table(table)}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `.execute(db);
  }

  await sql`
    grant select, insert, update, delete on scans, disputes, dispute_evidence
    to tpirs_app
  `.execute(db);

  // A reversal must remove the period from the paid set so the offline client
  // cannot continue to show it as paid (ADR 0028).
  await sql`
    create function unpay_obligation_period_on_reversal() returns trigger as $$
    begin
      update obligation_periods
      set status = 'unpaid',
          amount_paid_minor = 0,
          paid_transaction_id = null,
          updated_at = now()
      where tenant_id = NEW.tenant_id
        and paid_transaction_id = NEW.original_transaction_id
        and status in ('paid', 'waived');
      return NEW;
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger reversal_unpays_obligation_period
      after update of status on reversal_requests
      for each row
      when (NEW.status = 'approved' and OLD.status = 'pending')
      execute function unpay_obligation_period_on_reversal()
  `.execute(db);

  // Note the full permission set for future backfills (lint/debug only).
  void ALL_PERMISSIONS;
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger if exists reversal_unpays_obligation_period on reversal_requests`.execute(db);
  await sql`drop function if exists unpay_obligation_period_on_reversal()`.execute(db);
  await sql`drop table if exists dispute_evidence cascade`.execute(db);
  await sql`drop table if exists disputes cascade`.execute(db);
  await sql`drop table if exists scans cascade`.execute(db);
}
