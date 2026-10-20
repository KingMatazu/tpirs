import type { FastifyInstance } from "fastify";
import { PortError } from "@tpirs/ports";
import type { DeviceRegistration } from "@tpirs/ports";
import { requirePrincipal, UnauthorizedError } from "../auth.js";
import { resolveTenantIdBySlug } from "../tenants.js";
import type { AuthContext } from "../auth.js";

interface LoginBody {
  readonly tenantSlug?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
  readonly totpCode?: unknown;
  readonly device?: unknown;
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

export function registerAuthRoutes(app: FastifyInstance, context: AuthContext): void {
  app.post("/v1/auth/login", async (request, reply) => {
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
      return await reply.send({
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        user: session.user,
      });
    } catch (error) {
      if (error instanceof PortError && error.code === "unauthorized") {
        return reply.code(401).send({
          error: { code: "unauthorized", message: "Invalid credentials", requestId: request.id },
        });
      }
      throw error;
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      const token = header.slice("Bearer ".length).trim();
      if (token.length > 0) {
        await context.identity.revokeSession(token);
      }
    }
    const principal = request.principal;
    if (principal !== undefined) {
      request.audit = { action: "auth.logout", entityType: "user", entityId: principal.userId };
    }
    return reply.code(204).send();
  });

  app.get("/v1/auth/me", (request, reply) => {
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
