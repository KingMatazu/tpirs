import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * The two columns onboarding needs before a tenant can exist.
 *
 * `email` is the account identifier a password reset will use once an email
 * provider is chosen. It is nullable in the schema on purpose: the users created
 * before this migration (the demo seed's staff) predate the field, and an
 * identifier nobody can receive mail at is not worth making mandatory in the
 * database. Every *new* account is required to carry one by the API, and the
 * unique index is partial for the same reason — many legacy rows may have no
 * address, but no two accounts in a tenant may share one.
 *
 * `must_change_credentials` is what keeps onboarding honest. Provisioning
 * creates `admin` with a known temporary password, and the flag confines that
 * account to the one route that replaces the credentials. Without it, the
 * temporary password would be a working login for anyone who raced the operator
 * to the wizard.
 *
 * The backfill gives seeded users a synthetic address derived from their tenant
 * so the column reads realistically in a demo without inventing a mailbox. It is
 * idempotent: rows that already have an email are left alone.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table users add column email citext`.execute(db);
  await sql`alter table users add column must_change_credentials boolean not null default false`.execute(
    db,
  );
  await sql`
    create unique index users_tenant_email_key on users (tenant_id, email)
    where email is not null
  `.execute(db);
  await sql`
    update users u
    set email = u.username || '@' || t.slug || '.example.gov'
    from tenants t
    where t.id = u.tenant_id and u.email is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists users_tenant_email_key`.execute(db);
  await sql`alter table users drop column if exists must_change_credentials`.execute(db);
  await sql`alter table users drop column if exists email`.execute(db);
}
