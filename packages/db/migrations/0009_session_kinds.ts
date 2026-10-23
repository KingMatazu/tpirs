import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * Session kinds for the browser session model (docs/decisions-needed.md D26).
 *
 * Staff logins now issue two tokens: a short-lived access token used as a
 * bearer, and a long-lived refresh token delivered only as an httpOnly cookie
 * scoped to `/v1/auth/refresh`. Both live in `sessions` so revocation, expiry,
 * and the token-hash lookup stay in one place; the `kind` column keeps the two
 * worlds apart so a refresh token is never usable as a bearer and an access
 * token can never rotate. Rotation revokes the old refresh session inside the
 * same transaction that creates the new pair, making replay visible as a
 * revoked row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sessions add column kind text not null default 'access'`.execute(db);
  await sql`
    alter table sessions add constraint sessions_kind_check
      check (kind in ('access', 'refresh'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sessions drop constraint if exists sessions_kind_check`.execute(db);
  await sql`alter table sessions drop column if exists kind`.execute(db);
}
