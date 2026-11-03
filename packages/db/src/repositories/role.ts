import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface RoleRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

/** One role granted to one user, and whether it is the role they were hired for. */
export interface UserRoleGrant {
  readonly key: string;
  readonly isPrimary: boolean;
}

export class RoleRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: {
    tenantId: string;
    key: string;
    name: string;
    permissions: readonly string[];
  }): Promise<RoleRecord> {
    const role = await this.db
      .insertInto("roles")
      .values({ tenantId: input.tenantId, key: input.key, name: input.name })
      .returning(["id", "key", "name"])
      .executeTakeFirstOrThrow();
    if (input.permissions.length > 0) {
      await this.db
        .insertInto("rolePermissions")
        .values(
          input.permissions.map((permission) => ({
            roleId: role.id,
            tenantId: input.tenantId,
            permission,
          })),
        )
        .execute();
    }
    return { ...role, permissions: [...input.permissions] };
  }

  /**
   * `tenantId` is optional because a tenant-scoped handle already filters by
   * RLS; it is required for callers running under the system scope (the seed),
   * where roles are global across tenants and key alone is ambiguous.
   */
  async findByKey(key: string, tenantId?: string): Promise<RoleRecord | undefined> {
    let query = this.db.selectFrom("roles").select(["id", "key", "name"]).where("key", "=", key);
    if (tenantId !== undefined) query = query.where("tenantId", "=", tenantId);
    const role = await query.executeTakeFirst();
    if (role === undefined) return undefined;
    const permissions = await this.db
      .selectFrom("rolePermissions")
      .select("permission")
      .where("roleId", "=", role.id)
      .execute();
    return { ...role, permissions: permissions.map((p) => p.permission) };
  }

  async list(): Promise<readonly RoleRecord[]> {
    const roles = await this.db
      .selectFrom("roles")
      .select(["id", "key", "name"])
      .orderBy("key")
      .execute();
    const result: RoleRecord[] = [];
    for (const role of roles) {
      const permissions = await this.db
        .selectFrom("rolePermissions")
        .select("permission")
        .where("roleId", "=", role.id)
        .execute();
      result.push({ ...role, permissions: permissions.map((p) => p.permission) });
    }
    return result;
  }

  async assignToUser(input: { tenantId: string; userId: string; roleId: string }): Promise<void> {
    await this.db
      .insertInto("userRoles")
      .values({ tenantId: input.tenantId, userId: input.userId, roleId: input.roleId })
      .onConflict((oc) => oc.columns(["userId", "roleId"]).doNothing())
      .execute();
  }

  /** Distinct permission keys granted to a user through all their roles. */
  async permissionsForUser(userId: string): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("userRoles")
      .innerJoin("rolePermissions", "rolePermissions.roleId", "userRoles.roleId")
      .select("rolePermissions.permission")
      .distinct()
      .where("userRoles.userId", "=", userId)
      .execute();
    return rows.map((row) => row.permission);
  }

  /**
   * Role keys granted to a user, primary first, e.g. `["officer", "collector"]`.
   *
   * The order is the one the account list and the handover card print, so it is
   * part of the answer rather than incidental: the primary role comes first and
   * the rest follow alphabetically, which makes two reads of the same account
   * agree with each other.
   */
  async roleKeysForUser(userId: string): Promise<readonly string[]> {
    const granted = await this.rolesForUser(userId);
    return granted.map((role) => role.key);
  }

  /**
   * The grants themselves, primary first. Callers that need to know which role is
   * primary use this rather than taking the first key from `roleKeysForUser`,
   * because a grant written outside the service can carry no primary at all.
   */
  async rolesForUser(userId: string): Promise<readonly UserRoleGrant[]> {
    const rows = await this.db
      .selectFrom("userRoles")
      .innerJoin("roles", "roles.id", "userRoles.roleId")
      .select(["roles.key", "userRoles.isPrimary"])
      .where("userRoles.userId", "=", userId)
      .orderBy("userRoles.isPrimary", "desc")
      .orderBy("roles.key", "asc")
      .execute();
    return rows.map((row) => ({ key: row.key, isPrimary: row.isPrimary }));
  }

  /**
   * Marks one existing grant as the primary role, clearing any previous mark.
   *
   * The clear comes first on purpose: `user_roles_one_primary_idx` rejects a
   * second primary for the same user, so setting the flag without unsetting the
   * old one fails at the database rather than leaving two. The final update
   * touches nothing when the user does not hold the role, so callers must have
   * resolved the role for this user first.
   */
  async setPrimaryRoleForUser(input: { userId: string; roleId: string }): Promise<void> {
    await this.db
      .updateTable("userRoles")
      .set({ isPrimary: false })
      .where("userId", "=", input.userId)
      .execute();
    await this.db
      .updateTable("userRoles")
      .set({ isPrimary: true })
      .where("userId", "=", input.userId)
      .where("roleId", "=", input.roleId)
      .execute();
  }

  /**
   * Drops every role grant before a replacement set is applied. Deleting first
   * and inserting after, both inside the caller's transaction, means the user is
   * never briefly a mix of the old and the new role set.
   */
  async clearRolesForUser(userId: string): Promise<void> {
    await this.db.deleteFrom("userRoles").where("userId", "=", userId).execute();
  }
}
