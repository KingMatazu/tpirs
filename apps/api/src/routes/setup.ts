import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  OnboardingValidationError,
  TenantAlreadyProvisionedError,
  isSetupRequired,
  reissueAdminTemporaryPassword,
  startOnboarding,
} from "@tpirs/application";
import type { OnboardingIssue } from "@tpirs/application";
import type { RateLimiter } from "@tpirs/application";
import type { TenantConfigDefaultsInput } from "@tpirs/config";
import type { AnyDb } from "@tpirs/db";
import { setupAdminPasswordSchema, setupStatusSchema, setupTenantSchema } from "../schemas.js";

/**
 * First-run setup: the endpoints that turn an empty deployment into one with a
 * tenant.
 *
 * These exist only while the deployment has no tenant. That is the whole access
 * control: there is no account to authenticate as yet, so the protection is
 * that the window closes — the moment a tenant exists every route here answers
 * `404`, which is also the answer for a deployment that is simply finished. A
 * caller cannot distinguish "already set up" from "not a route", and neither
 * answer helps them.
 *
 * The decision to keep `SETUP_TOKEN` off is recorded with the phase: a token
 * that must be copied out of a log and into a browser is a step an operator
 * performs once, at the moment they are least practised at it, while the
 * alternative — finish setup before exposing the port — is a deployment
 * instruction rather than a secret that can be lost.
 */
export interface SetupContext {
  readonly db: AnyDb;
  /** The same limiter the auth routes use; compositions without one get none. */
  readonly rateLimiter?: RateLimiter;
  /**
   * Shared secret for first-run setup (ADR 0052). When set, creating the tenant
   * requires `x-setup-token` to match. Deployments exposed to the internet must
   * set it; a fresh production deployment without one refuses setup rather than
   * leaving the window open.
   */
  readonly setupToken?: string;
  /** `production` closes open setup; tests and local development stay open. */
  readonly nodeEnv?: string;
}

/**
 * Status is polled by every browser that loads the dashboard, so it is limited
 * like a login rather than left open. Creating a tenant hashes a password and
 * writes around twenty rows, so it is limited far more tightly.
 */
const STATUS_IP_LIMIT = { limit: 60, windowSeconds: 60 } as const;
const CREATE_IP_LIMIT = { limit: 10, windowSeconds: 60 } as const;
/** Password recovery is a brute-force target even with a token in front of it. */
const ADMIN_PASSWORD_IP_LIMIT = { limit: 5, windowSeconds: 60 } as const;

/** The wizard's answers, as they arrive. Fastify's schema has validated them. */
interface SetupTenantBody {
  readonly name: string;
  readonly slug: string;
  readonly legalEntity: string;
  readonly supportEmail: string;
  readonly supportPhone: string;
  readonly timezone: string;
  readonly currency: string;
  readonly ussdCode: string;
  readonly smsSenderId: string;
  readonly bikeFeeMinor: number;
  readonly tuktukFeeMinor: number;
  readonly adminEmail: string;
  readonly languages?: readonly string[];
  readonly defaultLanguage?: string;
  readonly appName?: string;
  readonly numberFormat?: string;
  readonly dateFormat?: string;
}

/**
 * The wizard does not ask about formatting: a levy office knows its currency and
 * its language, not its ICU locale. Number formatting follows the default
 * language (`en`, `fr`) and dates are written day-first, the form used in every
 * market this platform is sold into so far. Both are tenant config afterwards,
 * so getting them wrong costs an edit rather than a reinstall.
 */
const DEFAULT_DATE_FORMAT = "dd/MM/yyyy";

function notFound(reply: FastifyReply, request: { id: string }): FastifyReply {
  return reply.code(404).send({
    error: { code: "not_found", message: "Route not found", requestId: request.id },
  });
}

/** Constant-time comparison; a length mismatch is already a mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Decides whether this request may create the first tenant.
 *
 * `undefined` means allowed. The order matters: a configured token is checked
 * before the production rule, so a deployment that set one works, and a
 * production deployment without one fails closed instead of exposing a tenant
 * creation endpoint to the internet.
 */
function setupDenied(
  request: FastifyRequest,
  reply: FastifyReply,
  context: SetupContext,
): FastifyReply | undefined {
  if (context.setupToken !== undefined) {
    const header = request.headers["x-setup-token"];
    const provided = typeof header === "string" ? header : "";
    if (!tokenMatches(provided, context.setupToken)) {
      return reply.code(401).send({
        error: {
          code: "setup_token_required",
          message: "A valid setup token is required to create the first tenant",
          requestId: request.id,
        },
      });
    }
    return undefined;
  }
  if (context.nodeEnv === "production") {
    return reply.code(503).send({
      error: {
        code: "setup_disabled",
        message: "First-run setup is disabled because SETUP_TOKEN is not set on this deployment",
        requestId: request.id,
      },
    });
  }
  return undefined;
}

function invalidSetup(
  reply: FastifyReply,
  request: { id: string },
  issues: readonly OnboardingIssue[],
): FastifyReply {
  const message =
    issues.length === 1
      ? "1 answer needs attention"
      : `${String(issues.length)} answers need attention`;
  return reply.code(422).send({
    error: { code: "unprocessable_entity", message, requestId: request.id, issues },
  });
}

export function registerSetupRoutes(app: FastifyInstance, context: SetupContext): void {
  const limiter = context.rateLimiter;

  app.get("/v1/setup/status", { schema: setupStatusSchema }, async (request, reply) => {
    if (limiter !== undefined) {
      const byIp = await limiter.consume(`setup.status:ip:${request.ip}`, STATUS_IP_LIMIT);
      if (!byIp.allowed) {
        void reply.header("Retry-After", String(byIp.retryAfterSeconds));
        return reply.code(429).send({
          error: { code: "rate_limited", message: "Too many requests", requestId: request.id },
        });
      }
    }
    return reply.send({ needsSetup: await isSetupRequired(context.db) });
  });

  app.post(
    "/v1/setup/tenant",
    {
      schema: setupTenantSchema,
      // Fastify validates the body before the handler. On a configured
      // deployment that would answer 400 to a malformed body, revealing that
      // the route exists and what it accepts. The closed-window check therefore
      // runs in preValidation, so every response is the same 404.
      preValidation: async (request, reply) => {
        if (!(await isSetupRequired(context.db))) return notFound(reply, request);
        return setupDenied(request, reply, context);
      },
    },
    async (request, reply) => {
      if (limiter !== undefined) {
        const byIp = await limiter.consume(`setup.create:ip:${request.ip}`, CREATE_IP_LIMIT);
        if (!byIp.allowed) {
          void reply.header("Retry-After", String(byIp.retryAfterSeconds));
          return reply.code(429).send({
            error: { code: "rate_limited", message: "Too many requests", requestId: request.id },
          });
        }
      }

      const body = request.body as SetupTenantBody;
      const languages = body.languages ?? ["en"];
      const defaultLanguage = body.defaultLanguage ?? languages[0] ?? "en";

      const answers: TenantConfigDefaultsInput = {
        name: body.name,
        slug: body.slug,
        legalEntity: body.legalEntity,
        supportEmail: body.supportEmail,
        supportPhone: body.supportPhone,
        timezone: body.timezone,
        // Currency codes are upper case everywhere they are compared; a client
        // typing "ngn" should not fail three validators down.
        currency: body.currency.toUpperCase(),
        ussdCode: body.ussdCode,
        smsSenderId: body.smsSenderId,
        bikeFeeMinor: body.bikeFeeMinor,
        tuktukFeeMinor: body.tuktukFeeMinor,
        languages,
        defaultLanguage,
        numberFormat: body.numberFormat ?? defaultLanguage,
        dateFormat: body.dateFormat ?? DEFAULT_DATE_FORMAT,
        ...(body.appName === undefined ? {} : { appName: body.appName }),
      };

      try {
        const started = await startOnboarding(context.db, {
          config: answers,
          adminEmail: body.adminEmail,
        });
        return await reply.code(201).send({
          tenantSlug: answers.slug,
          temporaryUsername: started.temporaryUsername,
        });
      } catch (error) {
        if (error instanceof OnboardingValidationError) {
          return invalidSetup(reply, request, error.issues);
        }
        // Two requests raced, or the deployment was configured between the check
        // above and this call. Either way setup is done, and as far as the caller
        // is concerned this route no longer exists.
        if (error instanceof TenantAlreadyProvisionedError) return notFound(reply, request);
        throw error;
      }
    },
  );

  /**
   * Re-issues the tenant creator's temporary password for a locked-out operator.
   *
   * **Temporary measure** until forgot-password exists (ADR 0060). The account is
   * the tenant's first `system_admin` — the one that was provisioned — and the
   * authorisation is the deployment secret, not a session, because the caller by
   * definition cannot sign in. Every session ends and the next sign-in must
   * replace the password; the password is returned once, never stored.
   */
  app.post(
    "/v1/setup/admin-password",
    { schema: setupAdminPasswordSchema },
    async (request, reply) => {
      const denied = adminPasswordDenied(request, reply, context);
      if (denied !== undefined) return denied;
      if (limiter !== undefined) {
        const byIp = await limiter.consume(
          `setup.admin_password:ip:${request.ip}`,
          ADMIN_PASSWORD_IP_LIMIT,
        );
        if (!byIp.allowed) {
          void reply.header("Retry-After", String(byIp.retryAfterSeconds));
          return reply.code(429).send({
            error: { code: "rate_limited", message: "Too many requests", requestId: request.id },
          });
        }
      }

      const body = request.body as { tenantSlug?: unknown };
      const tenantSlug = typeof body.tenantSlug === "string" ? body.tenantSlug : "";
      const reissued = await reissueAdminTemporaryPassword(context.db, { tenantSlug });
      // An unknown tenant and a tenant with no administrator are the same answer:
      // the caller holds the secret, but the route still says nothing about which
      // tenants exist beyond the one they named.
      if (reissued === undefined) return notFound(reply, request);
      return reply.send({ username: reissued.username, password: reissued.password });
    },
  );
}

/**
 * Whether a request may re-issue an administrator's password.
 *
 * Stricter than `setupDenied`: that one lets a deployment without a token run
 * first-time setup, which is harmless because it closes itself. This route is
 * open for as long as the deployment exists, so it requires the token in every
 * environment — a password-reset endpoint with no secret is a backdoor, not a
 * convenience.
 */
function adminPasswordDenied(
  request: FastifyRequest,
  reply: FastifyReply,
  context: SetupContext,
): FastifyReply | undefined {
  if (context.setupToken === undefined) {
    return reply.code(503).send({
      error: {
        code: "setup_disabled",
        message: "Password recovery is disabled because SETUP_TOKEN is not set on this deployment",
        requestId: request.id,
      },
    });
  }
  const header = request.headers["x-setup-token"];
  const provided = typeof header === "string" ? header : "";
  if (!tokenMatches(provided, context.setupToken)) {
    return reply.code(401).send({
      error: {
        code: "setup_token_required",
        message: "A valid setup token is required to re-issue an administrator password",
        requestId: request.id,
      },
    });
  }
  return undefined;
}
