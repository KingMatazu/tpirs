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

/**
 * Resolves the session token into a principal with its granted permissions.
 *
 * The account row is read on every request for one reason: whether it still
 * holds provisioning credentials is a property of the *account*, not of the
 * session that was issued, and a token minted before onboarding finished must
 * not outlive the gate that token was issued under. It is a primary-key lookup
 * in the transactions the permission query already opens.
 *
 * A session whose account has been deleted resolves to nothing rather than to a
 * permissionless principal: a token is not a claim that the account exists.
 */
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
  const account = await withTenant(context.db, staff.tenantId, async (tx) => {
    const repos = repositories(tx);
    const [permissionKeys, user] = await Promise.all([
      repos.roles.permissionsForUser(staff.userId),
      repos.users.findById(staff.userId),
    ]);
    return { permissionKeys, user };
  });
  if (account.user === undefined) return undefined;
  return principal({
    userId: staff.userId,
    tenantId: staff.tenantId,
    displayName: staff.displayName,
    roles: staff.roles,
    permissions: account.permissionKeys,
    mustChangeCredentials: account.user.mustChangeCredentials,
  });
}

/** The access token a client presented, if any. Exported for logout and rotation. */
export function bearerToken(request: FastifyRequest): string | undefined {
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

/**
 * The only routes an account holding provisioning credentials may reach.
 *
 * Kept as route patterns rather than permissions: this is not an authorisation
 * decision an operator can grant, it is the shape of the onboarding handshake.
 * `auth/me` and `auth/refresh` are here because a browser that reloads
 * mid-onboarding has only a cookie and needs to be told, not signed out; logout
 * is here so the person can abandon setup without completing it.
 */
const CREDENTIAL_ROTATION_ROUTES: readonly string[] = [
  "POST /v1/auth/complete-onboarding",
  "POST /v1/auth/logout",
  "POST /v1/auth/refresh",
  "GET /v1/auth/me",
];

/**
 * Refuses every request from an account that still holds its provisioning
 * credentials, except the ones that replace them.
 *
 * A temporary password is not a weak password — it is a published one. Until it
 * is replaced, the account has effectively no credentials at all, so the useful
 * posture is to let it do exactly one thing rather than to let it in and warn.
 * The response carries its own code so a client can tell this apart from a
 * permission failure: the remedy is to finish onboarding, not to ask for access.
 */
export function enforceCredentialRotation() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const current = request.principal;
    if (current?.mustChangeCredentials !== true) return undefined;
    const route = `${request.method} ${request.routeOptions.url ?? ""}`;
    if (CREDENTIAL_ROTATION_ROUTES.includes(route)) return undefined;
    return reply.code(403).send({
      error: {
        code: "must_change_credentials",
        message: "This account must replace its temporary credentials before it can be used",
        requestId: request.id,
      },
    });
  };
}
