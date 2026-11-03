import type { Kysely } from "kysely";
import { SYSTEM_ROLES } from "@tpirs/domain";
import { hashPassword } from "@tpirs/crypto";
import type { TenantConfig } from "@tpirs/config";
import type { Database } from "./connection.js";
import { repositories } from "./repositories/index.js";
import { withSystem } from "./tenant-scope.js";

/**
 * The rows a tenant needs to exist: the tenant, its system roles, its zones and
 * its first user.
 *
 * This is the one provisioning path in the codebase. Both the first-run
 * onboarding endpoints (`@tpirs/application`) and the demo seed call it, so a
 * tenant created by a state and a tenant created by `pnpm setup --seed` are the
 * same shape by construction rather than by convention.
 *
 * It lives in `@tpirs/db` and not in `@tpirs/application` because the seed is
 * here and the dependency only runs one way (`application` → `db`); see the note
 * at the top of `seed-cash.ts`. The *rules* — which credential may replace the
 * temporary one, what the wizard may ask for — live in the application service
 * that wraps this.
 *
 * It runs system-scoped on purpose. `withSystem` is documented as "provisioning
 * and seeding, never request handling", and this is the provisioning it names:
 * at this point there is no tenant to scope to.
 */

export class TenantAlreadyProvisionedError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`A tenant with slug '${slug}' already exists`);
    this.name = "TenantAlreadyProvisionedError";
    this.slug = slug;
  }
}

export interface ProvisionAdminInput {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  /** Plain password, hashed here. Never logged and never stored in the clear. */
  readonly password: string;
  /** Defaults to `system_admin`; the seeded role keys are the only valid values. */
  readonly roleKeys?: readonly string[];
  /**
   * True when the password is a known temporary one (onboarding). The account
   * can then reach only the route that replaces its credentials.
   */
  readonly mustChangeCredentials?: boolean;
}

export interface ProvisionTenantInput {
  readonly config: TenantConfig;
  readonly admin: ProvisionAdminInput;
  /** Optional zones. A tenant with none is valid; the admin adds them later. */
  readonly zones?: readonly string[];
  /**
   * Refresh the config and roles of an existing tenant instead of failing.
   * Used by the demo seed, which owns its fixtures and re-runs on every setup.
   */
  readonly updateExisting?: boolean;
}

export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly adminUserId: string;
  /** False when an existing tenant was refreshed rather than created. */
  readonly created: boolean;
}

export async function provisionTenantRows(
  db: Kysely<Database>,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  const { config } = input;
  return withSystem(db, async (tx) => {
    const repos = repositories(tx);

    const existing = await repos.tenants.findBySlug(config.identity.slug);
    if (existing !== undefined && input.updateExisting !== true) {
      throw new TenantAlreadyProvisionedError(config.identity.slug);
    }
    const tenant =
      existing ??
      (await repos.tenants.create({
        slug: config.identity.slug,
        name: config.identity.name,
        legalEntity: config.identity.legalEntity,
        config,
      }));
    if (existing !== undefined) {
      await repos.tenants.updateConfig(existing.id, config);
    }

    const roleIds = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      const existingRole = await repos.roles.findByKey(role.key, tenant.id);
      const created =
        existingRole ??
        (await repos.roles.create({
          tenantId: tenant.id,
          key: role.key,
          name: role.name,
          permissions: role.permissions,
        }));
      roleIds.set(role.key, created.id);
    }

    // Zones are only created with the tenant. Re-running against an existing
    // tenant must not add zones an operator deleted on purpose.
    if (existing === undefined) {
      for (const name of input.zones ?? []) {
        await repos.zones.create({ tenantId: tenant.id, parentZoneId: null, name });
      }
    }

    // Scoped lookup: `username` is unique per tenant, and this connection is
    // outside row-level security, so an unscoped match could be another state's
    // user with the same name.
    const existingAdmin = await repos.users.findByUsernameInTenant(tenant.id, input.admin.username);
    const admin =
      existingAdmin ??
      (await repos.users.create({
        tenantId: tenant.id,
        username: input.admin.username,
        displayName: input.admin.displayName,
        email: input.admin.email,
        passwordHash: await hashPassword(input.admin.password),
        totpSecret: null,
        mustChangeCredentials: input.admin.mustChangeCredentials ?? false,
      }));

    const roleKeys = input.admin.roleKeys ?? ["system_admin"];
    for (const roleKey of roleKeys) {
      const roleId = roleIds.get(roleKey);
      if (roleId === undefined) continue;
      await repos.roles.assignToUser({ tenantId: tenant.id, userId: admin.id, roleId });
    }
    // Idempotent on a re-run: `tenant:create` may find the administrator already
    // there, and the mark is moved rather than inserted a second time.
    const primaryRoleKey = roleKeys.find((roleKey) => roleIds.has(roleKey));
    const primaryRoleId = primaryRoleKey === undefined ? undefined : roleIds.get(primaryRoleKey);
    if (primaryRoleId !== undefined) {
      await repos.roles.setPrimaryRoleForUser({ userId: admin.id, roleId: primaryRoleId });
    }

    return { tenantId: tenant.id, adminUserId: admin.id, created: existing === undefined };
  });
}
