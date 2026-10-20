import { isPermission } from "./tenancy.js";
import type { Permission } from "./tenancy.js";

/** The authenticated caller, resolved from a session. */
export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
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
