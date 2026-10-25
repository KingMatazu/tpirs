import type { FastifyInstance, FastifyReply } from "fastify";
import { PortError } from "@tpirs/ports";
import type { DeviceRegistration } from "@tpirs/ports";
import { requirePrincipal, UnauthorizedError } from "../auth.js";
import { resolveTenantIdBySlug } from "../tenants.js";
import type { AuthContext } from "../auth.js";
import { authLoginSchema, authLogoutSchema, authMeSchema, authRefreshSchema } from "../schemas.js";

interface LoginBody {
  readonly tenantSlug?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
  readonly totpCode?: unknown;
  readonly device?: unknown;
}

/** Name of the D26 refresh cookie; scoped to the refresh endpoint only. */
export const REFRESH_COOKIE = "tpirs_refresh";

/**
 * Cookie options for the D26 refresh token: httpOnly so page script can never
 * read it, SameSite strict so cross-site navigation does not carry it, Secure
 * everywhere (localhost is exempt in modern browsers), and scoped to the refresh
 * path so no other endpoint ever receives it.
 */
function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  const maxAgeSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(REFRESH_COOKIE, token, {
    path: "/v1/auth/refresh",
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    maxAge: maxAgeSeconds,
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asDevice(value: unknown): DeviceRegistration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const deviceId = asString(record.deviceId);
  const platform = asString(record.platform);
  if (deviceId === undefined || platform === undefined) return undefined;
  return { deviceId, platform };
}

/** Response body shared by login and refresh; both rotate the refresh cookie. */
async function sessionReply(
  reply: FastifyReply,
  session: {
    token: string;
    expiresAt: Date;
    refreshToken: string;
    refreshExpiresAt: Date;
    user: { userId: string; tenantId: string; displayName: string; roles: readonly string[] };
  },
): Promise<unknown> {
  setRefreshCookie(reply, session.refreshToken, session.refreshExpiresAt);
  return reply.send({
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
    user: {
      userId: session.user.userId,
      tenantId: session.user.tenantId,
      displayName: session.user.displayName,
      roles: session.user.roles,
    },
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.refreshExpiresAt.toISOString(),
  });
}

export function registerAuthRoutes(app: FastifyInstance, context: AuthContext): void {
  app.post("/v1/auth/login", { schema: authLoginSchema }, async (request, reply) => {
    const body = (request.body ?? {}) as LoginBody;
    const tenantSlug = asString(body.tenantSlug);
    const username = asString(body.username);
    const password = asString(body.password);
    if (tenantSlug === undefined || username === undefined || password === undefined) {
      return reply.code(400).send({
        error: {
          code: "bad_request",
          message: "tenantSlug, username, and password are required",
          requestId: request.id,
        },
      });
    }

    const tenantId = await resolveTenantIdBySlug(context.db, tenantSlug);
    if (tenantId === undefined) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Invalid credentials", requestId: request.id },
      });
    }

    const totpCode = asString(body.totpCode);
    const device = asDevice(body.device);
    try {
      const session = await context.identity.authenticate({
        tenantId,
        username,
        password,
        ...(totpCode === undefined ? {} : { totpCode }),
        ...(device === undefined ? {} : { device }),
      });
      request.audit = {
        action: "auth.login",
        entityType: "user",
        entityId: session.user.userId,
      };
      return await sessionReply(reply, session);
    } catch (error) {
      if (error instanceof PortError && error.code === "unauthorized") {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Invalid credentials", requestId: request.id },
        });
      }
      throw error;
    }
  });

  /**
   * D26 silent re-login: the browser presents only the scoped httpOnly cookie;
   * the server rotates the refresh token (single use) and issues a new access
   * token. A revoked, expired, replayed, or absent token fails closed with 401.
   */
  app.post("/v1/auth/refresh", { schema: authRefreshSchema }, async (request, reply) => {
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (typeof refreshToken !== "string" || refreshToken === "") {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Refresh token is missing",
          requestId: request.id,
        },
      });
    }
    try {
      const rotated = await context.identity.refreshSession(refreshToken);
      request.audit = {
        action: "auth.refresh",
        entityType: "user",
        entityId: rotated.user.userId,
      };
      return await sessionReply(reply, rotated);
    } catch (error) {
      if (error instanceof PortError && error.code === "unauthorized") {
        reply.clearCookie(REFRESH_COOKIE, { path: "/v1/auth/refresh" });
        return reply.code(401).send({
          error: {
            code: "unauthorized",
            message: "Refresh token is unknown, expired, or revoked",
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });

  app.post("/v1/auth/logout", { schema: authLogoutSchema }, async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (token.length > 0) {
        await context.identity.revokeSession(token);
      }
    }
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (typeof refreshToken === "string" && refreshToken !== "") {
      await context.identity.revokeSession(refreshToken);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/v1/auth/refresh" });
    const principal = request.principal;
    if (principal !== undefined) {
      request.audit = { action: "auth.logout", entityType: "user", entityId: principal.userId };
    }
    return reply.code(204).send();
  });

  app.get("/v1/auth/me", { schema: authMeSchema }, (request, reply) => {
    let principal;
    try {
      principal = requirePrincipal(request);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return reply
          .code(401)
          .send({ error: { code: "unauthorized", message: error.message, requestId: request.id } });
      }
      throw error;
    }
    return reply.send({
      userId: principal.userId,
      tenantId: principal.tenantId,
      displayName: principal.displayName,
      roles: principal.roles,
      permissions: principal.permissions,
    });
  });
}
