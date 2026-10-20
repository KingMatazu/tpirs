import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Phase 2: asset registry.
 *
 * Owners (asset holders) and the generic `assets` table. Asset attributes are
 * tenant-defined and validated by the AssetSchemaRegistry against tenant config,
 * so attributes live in one jsonb column rather than fixed columns. The QR
 * payload is an opaque random id; the printed token is payload + HMAC checksum,
 * so a sticker reveals nothing and forgeries fail closed. Every table is
 * tenant-scoped with the same row-level security pattern as Phase 1.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table owners (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      display_name text not null,
      phone text not null,
      phone_verified_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, phone)
    )
  `.execute(db);
  await sql`create index owners_tenant_idx on owners (tenant_id)`.execute(db);

  await sql`
    create table assets (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      zone_id uuid references zones(id),
      owner_id uuid references owners(id),
      asset_type_key text not null,
      status text not null default 'active',
      attributes jsonb not null default '{}'::jsonb,
      qr_payload text not null,
      qr_token text not null,
      short_code text not null,
      created_by_user_id uuid references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, qr_payload),
      unique (tenant_id, short_code),
      constraint assets_status_check check (status in ('active', 'suspended', 'retired'))
    )
  `.execute(db);
  await sql`create index assets_tenant_idx on assets (tenant_id)`.execute(db);
  await sql`create index assets_tenant_type_idx on assets (tenant_id, asset_type_key)`.execute(db);
  await sql`create index assets_owner_idx on assets (owner_id)`.execute(db);
  await sql`create index assets_zone_idx on assets (zone_id)`.execute(db);

  await sql`
    create table asset_photos (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references tenants(id),
      asset_id uuid not null references assets(id),
      object_key text not null,
      content_type text not null,
      created_by_user_id uuid references users(id),
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index asset_photos_tenant_idx on asset_photos (tenant_id)`.execute(db);
  await sql`create index asset_photos_asset_idx on asset_photos (asset_id)`.execute(db);

  const tenantTables = ["owners", "assets", "asset_photos"];
  for (const table of tenantTables) {
    await sql`alter table ${sql.table(table)} enable row level security`.execute(db);
    await sql`
      create policy ${sql.raw(`tenant_isolation_${table}`)} on ${sql.table(table)}
      using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    `.execute(db);
  }

  await sql`
    grant select, insert, update, delete on owners, assets, asset_photos
    to tpirs_app
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists asset_photos cascade`.execute(db);
  await sql`drop table if exists assets cascade`.execute(db);
  await sql`drop table if exists owners cascade`.execute(db);
}
