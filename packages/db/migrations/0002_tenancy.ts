import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 1: tenancy, identity, RBAC, and the append-only audit log.
 *
 * Multi-tenancy is enforced at the database level so shared and dedicated
 * deployments run identical code: every tenant-scoped table carries tenant_id
 * and row-level security keyed on the `app.tenant_id` session setting. The
 * append-only audit table rejects UPDATE and DELETE with a trigger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists citext`.execute(db);

  await sql`
    create table tenants (
      id uuid primary key default gen_random_uuid(),
      slug citext not null unique,
      name text not null,
      legal_entity text not null,
      config jsonb not null,
      config_version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);

  await sql`
    create table zones (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      parent_zone_id uuid references zones(id),
      name text not null,
      created_at timestamptz not null default now(),
      unique (tenant_id, parent_zone_id, name)
    )
  `.execute(db);
  await sql`create index zones_tenant_idx on zones (tenant_id)`.execute(db);

  await sql`
    create table users (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      username citext not null,
      display_name text not null,
      password_hash text not null,
      totp_secret text,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, username),
      constraint users_status_check check (status in ('active', 'disabled'))
    )
  `.execute(db);
  await sql`create index users_tenant_idx on users (tenant_id)`.execute(db);

  await sql`
    create table roles (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      key text not null,
      name text not null,
      created_at timestamptz not null default now(),
      unique (tenant_id, key)
    )
  `.execute(db);
  await sql`create index roles_tenant_idx on roles (tenant_id)`.execute(db);

  await sql`
    create table role_permissions (
      role_id uuid not null references roles(id),
      tenant_id uuid not null references tenants(id),
      permission text not null,
      primary key (role_id, permission)
    )
  `.execute(db);
  await sql`create index role_permissions_tenant_idx on role_permissions (tenant_id)`.execute(db);

  await sql`
    create table user_roles (
      user_id uuid not null references users(id),
      role_id uuid not null references roles(id),
      tenant_id uuid not null references tenants(id),
      primary key (user_id, role_id)
    )
  `.execute(db);
  await sql`create index user_roles_tenant_idx on user_roles (tenant_id)`.execute(db);

  await sql`
    create table devices (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      user_id uuid not null references users(id),
      device_id text not null,
      platform text not null,
      bound_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      revoked_at timestamptz,
      unique (tenant_id, user_id, device_id)
    )
  `.execute(db);
  await sql`create index devices_tenant_idx on devices (tenant_id)`.execute(db);

  await sql`
    create table sessions (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      user_id uuid not null references users(id),
      token_hash text not null unique,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index sessions_tenant_idx on sessions (tenant_id)`.execute(db);
  await sql`create index sessions_user_idx on sessions (user_id)`.execute(db);

  await sql`
    create table audit_log (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid references tenants(id),
      actor_user_id uuid references users(id),
      action text not null,
      entity_type text not null,
      entity_id text,
      before_data jsonb,
      after_data jsonb,
      request_id text,
      ip text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index audit_log_tenant_idx on audit_log (tenant_id, created_at)`.execute(db);
  await sql`create index audit_log_entity_idx on audit_log (entity_type, entity_id)`.execute(db);

  // Append-only enforcement for audit_log: reject UPDATE and DELETE at the DB level.
  await sql`
    create function reject_audit_mutation() returns trigger as $$
    begin
      raise exception 'audit_log is append-only';
    end;
    $$ language plpgsql
  `.execute(db);
  await sql`
    create trigger audit_log_no_update
      before update or delete on audit_log
      for each row execute function reject_audit_mutation()
  `.execute(db);

  // Row-level security. Policies are permissive when app.tenant_id is unset,
  // which only happens for privileged migration/seed connections; application
  // connections must set it per request.
  const tenantTables = [
    "zones",
    "users",
    "roles",
    "role_permissions",
    "user_roles",
    "devices",
    "sessions",
  ];
  for (const table of tenantTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`
      create policy ${sql.raw(`tenant_isolation_${table}`)} on ${sql.table(table)}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `.execute(db);
  }
  await sql`alter table audit_log enable row level security`.execute(db);
  await sql`
    create policy tenant_isolation_audit_log on audit_log
    using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (true)
  `.execute(db);

  // A non-owner application role. Table owners bypass RLS by default, so the
  // app (and RLS tests) must run as this role — via `set local role tpirs_app`
  // — for row-level security to apply.
  await sql`create role tpirs_app nologin`.execute(db);
  await sql`grant usage on schema public to tpirs_app`.execute(db);
  await sql`
    grant select, insert, update, delete on
      tenants, zones, users, roles, role_permissions, user_roles, devices, sessions
    to tpirs_app
  `.execute(db);
  await sql`grant select, insert on audit_log to tpirs_app`.execute(db);
  await sql`grant execute on function reject_audit_mutation() to tpirs_app`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists audit_log cascade`.execute(db);
  await sql`drop function if exists reject_audit_mutation() cascade`.execute(db);
  await sql`drop table if exists sessions cascade`.execute(db);
  await sql`drop table if exists devices cascade`.execute(db);
  await sql`drop table if exists user_roles cascade`.execute(db);
  await sql`drop table if exists role_permissions cascade`.execute(db);
  await sql`drop table if exists roles cascade`.execute(db);
  await sql`drop table if exists users cascade`.execute(db);
  await sql`drop table if exists zones cascade`.execute(db);
  await sql`drop table if exists tenants cascade`.execute(db);
  // Revoke the app role's privileges before dropping it; `drop role` refuses
  // while any grant depends on the role.
  await sql`drop owned by tpirs_app`.execute(db);
  await sql`revoke all on schema public from tpirs_app`.execute(db);
  await sql`drop role if exists tpirs_app`.execute(db);
  await sql`drop extension if exists citext`.execute(db);
}
