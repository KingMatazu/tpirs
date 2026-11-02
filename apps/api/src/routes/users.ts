import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  UserConflictError,
  UserNotFoundError,
  UserValidationError,
  createUser,
  getUser,
  listRoles,
  listUsers,
  resetUserPassword,
  updateUser,
} from "@tpirs/application";
import type { UserIssue } from "@tpirs/application";
import type { AnyDb } from "@tpirs/db";
import { requirePermission } from "../auth.js";
import {
  createUserSchema,
  listRolesSchema,
  listUsersSchema,
  resetUserPasswordSchema,
  updateUserSchema,
} from "../schemas.js";

/**
 * Staff account management (Phase 11, 11.0b). See
 * `@tpirs/application/src/user-service.ts` for the rules; this file only
 * translates them into HTTP. Two properties matter at this layer:
 *
 * - **No credential in a response or the trail.** The service returns summaries
 *   that cannot carry a password hash, and the audit descriptors built below name
 *   only the account, the status and the role keys.
 * - **The caller's tenant, never the body's.** Every call is scoped to the
 *   principal's tenant; a user id from another tenant is simply not found.
 */
export interface UserRoutesContext {
  readonly db: AnyDb;
}

function badRequest(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: { code: "bad_request", message, requestId: request.id } });
}

function conflict(request: FastifyRequest, reply: FastifyReply, message: string) {
  return reply.code(409).send({ error: { code: "conflict", message, requestId: request.id } });
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: "not_found", message: "User not found", requestId: request.id },
  });
}

function unprocessable(request: FastifyRequest, reply: FastifyReply, issues: readonly UserIssue[]) {
  return reply.code(422).send({
    error: {
      code: "unprocessable_entity",
      message: "The account details were not accepted",
      requestId: request.id,
      issues,
    },
  });
}

/** The one place a service error becomes a status code. */
function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply | undefined {
  if (error instanceof UserValidationError) return unprocessable(request, reply, error.issues);
  if (error instanceof UserConflictError) return conflict(request, reply, error.message);
  if (error instanceof UserNotFoundError) return notFound(request, reply);
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function registerUserRoutes(app: FastifyInstance, context: UserRoutesContext): void {
  app.get("/v1/users", { schema: listUsersSchema }, async (request, reply) => {
    const principal = requirePermission(request, "user:read");
    const users = await listUsers(context.db, principal.tenantId);
    return reply.send({ users });
  });

  /**
   * The role catalogue the account editor offers. Guarded by `role:read`, so a
   * user administrator without `user:manage` can still see what a role means.
   */
  app.get("/v1/roles", { schema: listRolesSchema }, async (request, reply) => {
    const principal = requirePermission(request, "role:read");
    const roles = await listRoles(context.db, principal.tenantId);
    return reply.send({ roles });
  });

  app.post("/v1/users", { schema: createUserSchema }, async (request, reply) => {
    const principal = requirePermission(request, "user:manage");
    const body = (request.body ?? {}) as {
      username?: unknown;
      displayName?: unknown;
      email?: unknown;
      password?: unknown;
      roleKeys?: unknown;
    };
    const username = asString(body.username);
    const displayName = asString(body.displayName);
    const email = asString(body.email);
    const password = asString(body.password);
    const roleKeys = Array.isArray(body.roleKeys)
      ? body.roleKeys.filter((key): key is string => typeof key === "string")
      : [];
    if (
      username === undefined ||
      displayName === undefined ||
      email === undefined ||
      password === undefined
    ) {
      return badRequest(request, reply, "username, displayName, email and password are required");
    }

    try {
      const user = await createUser(context.db, {
        tenantId: principal.tenantId,
        username,
        displayName,
        email,
        password,
        roleKeys,
      });
      request.audit = {
        action: "user.create",
        entityType: "user",
        entityId: user.id,
        after: { username: user.username, status: user.status, roles: user.roles },
      };
      return await reply.code(201).send({ user });
    } catch (error) {
      const sent = sendError(request, reply, error);
      if (sent !== undefined) return sent;
      throw error;
    }
  });

  app.patch("/v1/users/:id", { schema: updateUserSchema }, async (request, reply) => {
    const principal = requirePermission(request, "user:manage");
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      displayName?: unknown;
      status?: unknown;
      roleKeys?: unknown;
    };
    const displayName = body.displayName === undefined ? undefined : asString(body.displayName);
    const status = body.status === "active" || body.status === "disabled" ? body.status : undefined;
    const roleKeys = Array.isArray(body.roleKeys)
      ? body.roleKeys.filter((key): key is string => typeof key === "string")
      : undefined;
    if (displayName === undefined && status === undefined && roleKeys === undefined) {
      // An empty patch is far more likely a client bug than an intent; saying so
      // is friendlier than a silent no-op the operator cannot see in the trail.
      return badRequest(request, reply, "Nothing to update: send displayName, status or roleKeys");
    }

    try {
      const previous = await getUser(context.db, principal.tenantId, id);
      if (previous === undefined) return await notFound(request, reply);
      const user = await updateUser(context.db, {
        tenantId: principal.tenantId,
        actorUserId: principal.userId,
        userId: id,
        ...(displayName === undefined ? {} : { displayName }),
        ...(status === undefined ? {} : { status }),
        ...(roleKeys === undefined ? {} : { roleKeys }),
      });
      request.audit = {
        action: "user.update",
        entityType: "user",
        entityId: user.id,
        before: {
          status: previous.status,
          roles: previous.roles,
          displayName: previous.displayName,
        },
        after: { status: user.status, roles: user.roles, displayName: user.displayName },
      };
      return await reply.send({ user });
    } catch (error) {
      const sent = sendError(request, reply, error);
      if (sent !== undefined) return sent;
      throw error;
    }
  });

  /**
   * Resets the password to a new temporary one. The response carries the same
   * summary as every other call — never the password — and the audit descriptor
   * records only that a reset happened.
   */
  app.post(
    "/v1/users/:id/password",
    { schema: resetUserPasswordSchema },
    async (request, reply) => {
      const principal = requirePermission(request, "user:manage");
      const { id } = request.params as { id: string };
      const password = asString((request.body as { password?: unknown }).password);
      if (password === undefined) return badRequest(request, reply, "A password is required");

      try {
        const user = await resetUserPassword(context.db, {
          tenantId: principal.tenantId,
          actorUserId: principal.userId,
          userId: id,
          password,
        });
        request.audit = {
          action: "user.password.reset",
          entityType: "user",
          entityId: user.id,
          after: { username: user.username, mustChangeCredentials: true },
        };
        return await reply.send({ user });
      } catch (error) {
        const sent = sendError(request, reply, error);
        if (sent !== undefined) return sent;
        throw error;
      }
    },
  );
}
