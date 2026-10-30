import type { FastifyReply, FastifyRequest } from "fastify";
import type { IdentityProvider } from "@tpirs/ports";
import type { RateLimiter } from "@tpirs/application";
import { PortError } from "@tpirs/ports";
import { principal } from "@tpirs/domain";
import type { Permission, Principal } from "@tpirs/domain";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";

export interface AuthContext {
  readonly identity: IdentityProvider;
  readonly db: AnyDb;
  /**
   * Abuse control for the unauthenticated auth routes (ADR 0046). Absent only in
   * compositions that have no limiter wired, in which case throttling is off —
   * the API always supplies one.
   */
  readonly rateLimiter?: RateLimiter;
  /**
   * Whether the D26 refresh cookie carries `Secure`. Defaults to true; local
   * development over plain http://localhost passes false so browsers keep it.
   */
  readonly secureCookies?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Resolves the session token into a principal with its granted permissions. */
async function resolvePrincipal(
  context: AuthContext,
  token: string,
): Promise<Principal | undefined> {
  let staff;
  try {
    staff = await context.identity.verifySession(token);
  } catch (error) {
    if (error instanceof PortError) return undefined;
    throw error;
  }
  const permissionKeys = await withTenant(context.db, staff.tenantId, async (tx) =>
    repositories(tx).roles.permissionsForUser(staff.userId),
  );
  return principal({
    userId: staff.userId,
    tenantId: staff.tenantId,
    displayName: staff.displayName,
    roles: staff.roles,
    permissions: permissionKeys,
  });
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Attaches `request.principal` when a valid bearer token is present. Routes that
 * require authentication call `requirePermission`, which fails closed.
 */
export function authenticate(context: AuthContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token === undefined) return;
    const resolved = await resolvePrincipal(context, token);
    if (resolved !== undefined) {
      request.principal = resolved;
    }
  };
}

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Returns the principal or throws UnauthorizedError. */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (request.principal === undefined) {
    throw new UnauthorizedError();
  }
  return request.principal;
}

/** Returns the principal, throwing if unauthenticated or missing permissions. */
export function requirePermission(
  request: FastifyRequest,
  ...permissions: readonly Permission[]
): Principal {
  const current = requirePrincipal(request);
  for (const permission of permissions) {
    if (!current.permissions.includes(permission)) {
      const error = new Error(`Missing permission "${permission}"`);
      error.name = "ForbiddenError";
      throw error;
    }
  }
  return current;
}
