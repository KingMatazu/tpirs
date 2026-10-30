import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "./config.js";
import { defaultErrorCode, errorEnvelope } from "./errors.js";
import { authenticate, UnauthorizedError } from "./auth.js";
import { auditOnSuccess } from "./audit.js";
import { sharedSchemas, healthSchema, readySchema } from "./schemas.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerVerificationAndSyncRoutes } from "./routes/field.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerCashRoutes } from "./routes/cash.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerReconciliationRoutes } from "./routes/reconciliation.js";
import { registerReversalRoutes } from "./routes/reversals.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Request span started on arrival and ended on response (ADR 0042). */
    metricsSpan?: import("@tpirs/ports").Span;
  }
}

export interface HealthResponse {
  readonly status: "ok";
  readonly service: string;
  readonly region: string;
  readonly version: string;
}

export interface ReadyResponse {
  readonly status: "ready" | "not_ready";
}

const VERSION = "0.0.0";

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, telemetry } = options;
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
  });

  await app.register(sensible);
  // Cookie parsing backs the D26 refresh cookie; nothing else reads cookies.
  await app.register(cookie);

  // OpenAPI 3 document emitted from the route schemas (D28): the running
  // server is the contract. The plugin must be registered (and awaited)
  // BEFORE any route is added, otherwise the document collects no paths.
  // Shared component schemas go on the instance so routes can $ref them.
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "tpirs API",
        version: VERSION,
        description: "Revenue collection platform API. Clients must use packages/api-client.",
      },
    },
  });
  for (const shared of sharedSchemas) {
    app.addSchema(shared);
  }

  app.get("/v1/openapi.json", { schema: { hide: true } }, (_request, reply) => {
    void reply.header("content-type", "application/json").send(app.swagger());
  });

  // Capture the raw body before JSON parsing so webhook signatures can be
  // verified byte-for-byte against the provider's payload.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      const parsed: unknown = JSON.parse(body as string);
      done(null, parsed);
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    done(null, body);
  });

  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    request.metricsSpan = telemetry.startSpan("http.request", { method: request.method });
    done();
  });

  if (options.identity !== undefined && options.db !== undefined) {
    app.addHook("onRequest", authenticate({ identity: options.identity, db: options.db }));
    app.addHook("onSend", auditOnSuccess(options.db));
    registerAuthRoutes(app, {
      identity: options.identity,
      db: options.db,
      // Secure cookies need HTTPS; local development is plain http://localhost.
      secureCookies: config.nodeEnv === "production",
    });
    registerConfigRoutes(app, { identity: options.identity, db: options.db });
    registerAuditRoutes(app, { db: options.db });
    if (options.services !== undefined) {
      registerPaymentRoutes(app, { services: options.services });
      registerCashRoutes(app, { services: options.services });
      registerReversalRoutes(app, { services: options.services });
      if (options.loadConfig !== undefined) {
        registerReconciliationRoutes(app, {
          services: options.services,
          loadConfig: options.loadConfig,
        });
      }
    }
  }

  if (
    options.services !== undefined &&
    options.loadConfig !== undefined &&
    options.db !== undefined
  ) {
    registerAssetRoutes(app, { services: options.services, loadConfig: options.loadConfig });
    registerVerifyRoutes(app, {
      services: options.services,
      loadConfig: options.loadConfig,
      db: options.db,
    });
    registerVerificationAndSyncRoutes(app, {
      services: options.services,
      loadConfig: options.loadConfig,
      db: options.db,
    });
  } else if (options.services !== undefined && options.loadConfig !== undefined) {
    registerAssetRoutes(app, { services: options.services, loadConfig: options.loadConfig });
    // Verify needs the db for paid-set lookups once obligations exist.
    // If db is not wired (e.g. tests without the full integration surface) skip.
  }

  // Webhooks are unauthenticated but tokenised; they must be registered even
  // before identity is fully configured, because providers call them directly.
  if (options.services !== undefined) {
    registerWebhookRoutes(app, { services: options.services });
  }
  // USSD/SMS provider callbacks resolve tenancy from the endpoint token, so
  // they need only the loader; the services bundle supplies the engine
  // instances and channel adapter factory.
  if (
    options.services !== undefined &&
    options.db !== undefined &&
    options.loadConfig !== undefined
  ) {
    registerChannelRoutes(app, {
      services: options.services,
      db: options.db,
      loadConfig: options.loadConfig,
    });
  }

  app.addHook("onResponse", (request, reply, done) => {
    // The route pattern, never the resolved path: `/v1/verify/:token` keeps the
    // label cardinality bounded, the token itself would blow it up (ADR 0042).
    const route = request.routeOptions.url ?? "unmatched";
    telemetry.counter("http.requests", 1, {
      method: request.method,
      status: reply.statusCode,
      route,
    });
    const span = request.metricsSpan;
    if (span !== undefined) {
      // Latency is labelled by route and method only; the status code lives on
      // the counter, so one slow path does not multiply the histogram series.
      span.setAttribute("route", route);
      span.end();
    }
    done();
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorEnvelope("not_found", "Route not found", request.id));
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const isUnauthorized = error instanceof UnauthorizedError;
    const isForbidden = error instanceof Error && error.name === "ForbiddenError";
    const statusCode = isUnauthorized
      ? 401
      : isForbidden
        ? 403
        : typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    const message = error instanceof Error ? error.message : "Internal server error";
    if (statusCode >= 500) {
      telemetry.captureError(error, {
        requestId: request.id,
        method: request.method,
        url: request.url,
      });
    }
    void reply
      .code(statusCode)
      .send(errorEnvelope(defaultErrorCode(statusCode), message, request.id));
  });

  app.get("/v1/health", { schema: healthSchema }, (_request, reply) => {
    const body: HealthResponse = {
      status: "ok",
      service: "tpirs",
      region: config.deploymentRegion,
      version: VERSION,
    };
    void reply.send(body);
  });

  app.get("/v1/ready", { schema: readySchema }, async (_request, reply) => {
    const ready = options.readiness === undefined ? true : await options.readiness();
    const body: ReadyResponse = { status: ready ? "ready" : "not_ready" };
    void reply.code(ready ? 200 : 503).send(body);
  });

  if (config.metricsEnabled && options.metrics !== undefined) {
    // Prometheus text exposition (ADR 0042): no authentication and outside the
    // audit hook, like /v1/health. It is an internal-network endpoint; a
    // deployment must not publish it at the edge.
    app.get("/metrics", { schema: { hide: true } }, (_request, reply) => {
      void reply
        .header("content-type", "text/plain; version=0.0.4")
        .send(options.metrics?.render());
    });
  }

  return app;
}
