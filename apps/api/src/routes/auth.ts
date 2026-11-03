import type { FastifyInstance, FastifyReply } from "fastify";
import { PortError } from "@tpirs/ports";
import type { DeviceRegistration } from "@tpirs/ports";
import {
  OnboardingValidationError,
  UserNotFoundError,
  UserValidationError,
  changeOwnPassword,
  completeOnboarding,
} from "@tpirs/application";
import { repositories, withTenant } from "@tpirs/db";
import { bearerToken, requirePrincipal, UnauthorizedError } from "../auth.js";
import { resolveTenantIdBySlug } from "../tenants.js";
import type { AuthContext } from "../auth.js";
import {
  authChangePasswordSchema,
  authCompleteOnboardingSchema,
  authLoginSchema,
  authLogoutSchema,
  authMeSchema,
  authRefreshSchema,
} from "../schemas.js";

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
 * read it, SameSite from deployment config (`strict` same-origin, `none` for a
 * split-origin hosted deployment), Secure everywhere production, and scoped to
 * the refresh path so no other endpoint ever receives it.
 */
function setRefreshCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  secure: boolean,
  sameSite: "strict" | "lax" | "none",
): void {
  const maxAgeSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(REFRESH_COOKIE, token, {
    path: "/v1/auth/refresh",
    httpOnly: true,
    sameSite,
    // Secure in production (HTTPS). Local development is served over plain
    // http://localhost, where browsers may drop a Secure cookie, which turned
    // every reload into a sign-out.
    secure,
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
  secure: boolean,
  sameSite: "strict" | "lax" | "none",
  mustChangeCredentials: boolean,
): Promise<unknown> {
  setRefreshCookie(reply, session.refreshToken, session.refreshExpiresAt, secure, sameSite);
  return reply.send({
    token: session.token,
    expiresAt: session.expiresAt.toISOString(),
    user: {
      userId: session.user.userId,
      tenantId: session.user.tenantId,
      displayName: session.user.displayName,
      roles: session.user.roles,
      mustChangeCredentials,
    },
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.refreshExpiresAt.toISOString(),
  });
}

/**
 * Whether the account that just authenticated still holds its provisioning
 * credentials.
 *
 * The identity port cannot answer this: it authenticates, it does not decide what
 * an authenticated account may do. Reading the row here keeps that decision in
 * one place — the same flag the request gate consults on every later call — so a
 * client is never told "you are free to go" by a response the server would then
 * refuse.
 */
async function mustChangeCredentials(
  context: AuthContext,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const user = await withTenant(context.db, tenantId, (tx) =>
    repositories(tx).users.findById(userId),
  );
  return user?.mustChangeCredentials ?? false;
}

/**
 * Login and refresh throttling (ADR 0046, D55). Two independent fixed windows on
 * login — per source IP and per username — plus one on refresh and one on TOTP.
 * Throttle, never lock out: the key expires on its own, so a guess cannot take a
 * named employee's account away from them.
 */
const LOGIN_IP_LIMIT = { limit: 60, windowSeconds: 60 } as const;
const LOGIN_USER_LIMIT = { limit: 5, windowSeconds: 60 } as const;
const LOGIN_TOTP_LIMIT = { limit: 5, windowSeconds: 60 } as const;
const REFRESH_IP_LIMIT = { limit: 30, windowSeconds: 60 } as const;

/** Key parts are normalised so case or whitespace cannot dodge a counter. */
function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function tooMany(reply: FastifyReply, request: { id: string }, retryAfterSeconds: number) {
  void reply.header("Retry-After", String(retryAfterSeconds));
  return reply.code(429).send({
    error: { code: "rate_limited", message: "Too many requests", requestId: request.id },
  });
}

export function registerAuthRoutes(app: FastifyInstance, context: AuthContext): void {
  const secureCookies = context.secureCookies ?? true;
  const sameSiteCookies = context.sameSiteCookies ?? "strict";
  const limiter = context.rateLimiter;
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

    // Both counters are consumed before the tenant or the user is looked up, so
    // a throttled answer is identical for existing and non-existent accounts and
    // cannot be used to enumerate usernames.
    if (limiter !== undefined) {
      const byIp = await limiter.consume(`login:ip:${request.ip}`, LOGIN_IP_LIMIT);
      if (!byIp.allowed) return tooMany(reply, request, byIp.retryAfterSeconds);
      const byUser = await limiter.consume(
        `login:user:${normalise(tenantSlug)}:${normalise(username)}`,
        LOGIN_USER_LIMIT,
      );
      if (!byUser.allowed) return tooMany(reply, request, byUser.retryAfterSeconds);
    }

    const tenantId = await resolveTenantIdBySlug(context.db, tenantSlug);
    if (tenantId === undefined) {
      return reply.code(401).send({
        error: { code: "unauthorized", message: "Invalid credentials", requestId: request.id },
      });
    }

    const totpCode = asString(body.totpCode);
    // The identity port checks password and TOTP together, so this counter is
    // consumed whenever a code is presented: that is the closest signal available
    // without splitting the port, and a wrong password with a code is harmless to
    // count here.
    if (limiter !== undefined && totpCode !== undefined) {
      const byTotp = await limiter.consume(
        `login:totp:${normalise(tenantSlug)}:${normalise(username)}`,
        LOGIN_TOTP_LIMIT,
      );
      if (!byTotp.allowed) return tooMany(reply, request, byTotp.retryAfterSeconds);
    }
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
      return await sessionReply(
        reply,
        session,
        secureCookies,
        sameSiteCookies,
        await mustChangeCredentials(context, session.user.tenantId, session.user.userId),
      );
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
    if (limiter !== undefined) {
      const byIp = await limiter.consume(`auth.refresh:ip:${request.ip}`, REFRESH_IP_LIMIT);
      if (!byIp.allowed) return tooMany(reply, request, byIp.retryAfterSeconds);
    }
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
      return await sessionReply(
        reply,
        rotated,
        secureCookies,
        sameSiteCookies,
        await mustChangeCredentials(context, rotated.user.tenantId, rotated.user.userId),
      );
    } catch (error) {
      if (error instanceof PortError && error.code === "unauthorized") {
        // The cookie is deliberately *not* cleared here. Refresh tokens rotate,
        // so two clients refreshing at once (two tabs, or React StrictMode
        // mounting an effect twice) race: the winner sets a fresh cookie and the
        // loser's clear can arrive after it and wipe it, signing the user out on
        // the next load. A dead cookie is harmless — it fails again and the user
        // signs in — while clearing a live one is not.
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
      mustChangeCredentials: principal.mustChangeCredentials,
    });
  });

  /**
   * The one thing an account holding provisioning credentials may do.
   *
   * Everything about this route is defined by that: it is authenticated (the
   * caller is the temporary account, no one else), it replaces the credentials on
   * the account it is called with, it clears the flag in the same statement, and
   * it hands back a working session so the person who just set a password is not
   * asked to type it again into a login form on the next screen.
   */
  app.post(
    "/v1/auth/complete-onboarding",
    { schema: authCompleteOnboardingSchema },
    async (request, reply) => {
      let principal;
      try {
        principal = requirePrincipal(request);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          return reply.code(401).send({
            error: { code: "unauthorized", message: error.message, requestId: request.id },
          });
        }
        throw error;
      }

      if (!principal.mustChangeCredentials) {
        // This is the end of provisioning, not a general self-service password
        // change. Once the flag is clear the route has nothing left to do.
        return reply.code(404).send({
          error: { code: "not_found", message: "Route not found", requestId: request.id },
        });
      }

      const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
      const username = asString(body.username);
      const password = asString(body.password);
      if (username === undefined || password === undefined) {
        return reply.code(400).send({
          error: {
            code: "bad_request",
            message: "username and password are required",
            requestId: request.id,
          },
        });
      }

      let completed;
      try {
        completed = await completeOnboarding(context.db, {
          tenantId: principal.tenantId,
          userId: principal.userId,
          username,
          password,
        });
      } catch (error) {
        if (error instanceof OnboardingValidationError) {
          return reply.code(422).send({
            error: {
              code: "unprocessable_entity",
              message: "The new credentials were not accepted",
              requestId: request.id,
              issues: error.issues,
            },
          });
        }
        throw error;
      }

      // The session that made this call was authorised by the temporary
      // credentials; it ends with them. Revoking first means a failure to mint
      // the replacement leaves the account signable-in with the password just
      // set, rather than leaving a token around that was issued to a password
      // nobody knows any more.
      const previous = bearerToken(request);
      if (previous !== undefined) await context.identity.revokeSession(previous);
      const session = await context.identity.authenticate({
        tenantId: principal.tenantId,
        username: completed.username,
        password,
      });
      // The service recorded `auth.credentials_changed` in the same transaction
      // as the rename; a second audit row here would describe the same event.
      return await sessionReply(reply, session, secureCookies, sameSiteCookies, false);
    },
  );

  /**
   * The staff version of the same handshake: keep the username the administrator
   * wrote on the handover card, replace the password they could read.
   *
   * A flagged account can reach nothing else, so this is the only door out of a
   * temporary password on the officer and collector apps — the dashboard has its
   * own form for the provisioning account. Once the flag is clear the route
   * answers 404, the same "nothing left to do" posture as onboarding.
   */
  app.post(
    "/v1/auth/change-password",
    { schema: authChangePasswordSchema },
    async (request, reply) => {
      let principal;
      try {
        principal = requirePrincipal(request);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          return reply.code(401).send({
            error: { code: "unauthorized", message: error.message, requestId: request.id },
          });
        }
        throw error;
      }

      if (!principal.mustChangeCredentials) {
        return reply.code(404).send({
          error: { code: "not_found", message: "Route not found", requestId: request.id },
        });
      }

      const password = asString((request.body as { password?: unknown }).password);
      if (password === undefined) {
        return reply.code(400).send({
          error: { code: "bad_request", message: "A password is required", requestId: request.id },
        });
      }

      let changed;
      try {
        changed = await changeOwnPassword(context.db, {
          tenantId: principal.tenantId,
          userId: principal.userId,
          password,
        });
      } catch (error) {
        if (error instanceof UserValidationError) {
          return reply.code(422).send({
            error: {
              code: "unprocessable_entity",
              message: "The new password was not accepted",
              requestId: request.id,
              issues: error.issues,
            },
          });
        }
        if (error instanceof UserNotFoundError) {
          return reply.code(404).send({
            error: { code: "not_found", message: "User not found", requestId: request.id },
          });
        }
        throw error;
      }

      // The service ended every session, including the one that made this call:
      // they were all authorised by the password that just stopped working. The
      // replacement is minted from the new one so nobody is asked to type it
      // again on the next screen.
      const session = await context.identity.authenticate({
        tenantId: principal.tenantId,
        username: changed.username,
        password,
      });
      return await sessionReply(reply, session, secureCookies, sameSiteCookies, false);
    },
  );
}
