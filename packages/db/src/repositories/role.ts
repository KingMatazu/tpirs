import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface RoleRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly string[];
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

  async findByKey(key: string): Promise<RoleRecord | undefined> {
    const role = await this.db
      .selectFrom("roles")
      .select(["id", "key", "name"])
      .where("key", "=", key)
      .executeTakeFirst();
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

  /** Role keys granted to a user, e.g. ["officer"]. */
  async roleKeysForUser(userId: string): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("userRoles")
      .innerJoin("roles", "roles.id", "userRoles.roleId")
      .select("roles.key")
      .where("userRoles.userId", "=", userId)
      .execute();
    return rows.map((row) => row.key);
  }
}
