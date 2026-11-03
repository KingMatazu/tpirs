import { sql } from "kysely";
import type { Kysely } from "kysely";

/**
 * One role per person is the primary one.
 *
 * `user_roles` is a set: an account can hold several roles and keeps the union of
 * their permissions. Operators still think in terms of the job someone was hired
 * for, and the account form now asks for it, so the grant needs somewhere to
 * record which role that was — otherwise the answer is lost the moment the form
 * is submitted and the account list can only print the roles in whatever order
 * the database returns them.
 *
 * The flag lives on the grant rather than on `users` because it describes one
 * user's assignment of one role, and `user_roles` is already that row.
 *
 * A partial unique index makes "at most one primary per person" a database
 * guarantee. "At least one" is not expressible as a constraint without a
 * deferred check, so the service owns it: every path that writes grants sets one.
 * A user with no primary is therefore representable, and reads as "no primary
 * recorded" rather than as an error — that is what a row written before this
 * migration looks like if the backfill found no role to choose.
 *
 * Backfill picks the alphabetically-first role key per user, which is stable: a
 * restored dump migrates to the same answer, and re-running the migration on the
 * same data marks the same row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table user_roles add column is_primary boolean not null default false`.execute(
    db,
  );

  await sql`
    update user_roles as granted
    set is_primary = true
    from (
      select distinct on (user_id) user_id, role_id
      from user_roles
      join roles on roles.id = user_roles.role_id
      order by user_id, roles.key
    ) as chosen
    where granted.user_id = chosen.user_id and granted.role_id = chosen.role_id
  `.execute(db);

  await sql`
    create unique index user_roles_one_primary_idx
    on user_roles (user_id)
    where is_primary
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists user_roles_one_primary_idx`.execute(db);
  await sql`alter table user_roles drop column if exists is_primary`.execute(db);
}
