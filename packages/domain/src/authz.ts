import { isPermission } from "./tenancy.js";
import type { Permission } from "./tenancy.js";

/** The authenticated caller, resolved from a session. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
  /**
   * The zone this person is responsible for, when their role has one.
   *
   * A zone supervisor registers vehicles in their own zone and nowhere else, and
   * a route has to judge that without a second query per request. Null for every
   * other role, and null for a supervisor whose zone was never recorded — the
   * latter is refused rather than treated as "every zone".
   */
  readonly zoneId: string | null;
  /**
   * True while the account still holds the credentials it was provisioned with.
   *
   * Onboarding has to create an account before anyone has chosen a username and
   * password for it, so the first account exists briefly with a known temporary
   * pair. The flag travels with the principal rather than living only in the
   * session, so every request — including one made with a token obtained before
   * the client noticed — is judged on the account's current state.
   */
  readonly mustChangeCredentials: boolean;
}

export class ForbiddenError extends Error {
  readonly permission: Permission | undefined;

  constructor(message: string, permission?: Permission) {
    super(message);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

/** Builds a principal, validating that every permission key is known. */
export function principal(input: {
  userId: string;
  tenantId: string;
  displayName: string;
  roles: readonly string[];
  permissions: readonly string[];
  /** The zone a supervisor is responsible for; omitted for every other role. */
  zoneId?: string | null;
  /** Defaults to false: only a provisioning flow sets it, and it clears itself. */
  mustChangeCredentials?: boolean;
}): Principal {
  const permissions: Permission[] = [];
  for (const value of input.permissions) {
    if (!isPermission(value)) {
      throw new ForbiddenError(`Unknown permission key "${value}"`);
    }
    permissions.push(value);
  }
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    displayName: input.displayName,
    roles: [...input.roles],
    permissions,
    zoneId: input.zoneId ?? null,
    mustChangeCredentials: input.mustChangeCredentials ?? false,
  };
}

export function can(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

/** Throws ForbiddenError unless the principal holds every listed permission. */
export function assertPermission(principal: Principal, ...required: readonly Permission[]): void {
  for (const permission of required) {
    if (!can(principal, permission)) {
      throw new ForbiddenError(`Missing permission "${permission}"`, permission);
    }
  }
}
