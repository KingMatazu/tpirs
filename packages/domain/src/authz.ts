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
