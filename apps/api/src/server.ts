import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sensible from "@fastify/sensible";
import type { BuildAppOptions } from "./config.js";
import { defaultErrorCode, errorEnvelope } from "./errors.js";
import { authenticate, UnauthorizedError } from "./auth.js";
import { auditOnSuccess } from "./audit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerVerifyRoutes } from "./routes/verify.js";

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

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, telemetry } = options;
  const app = Fastify({
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
  });

  void app.register(sensible);

  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
  });

  if (options.identity !== undefined && options.db !== undefined) {
    app.addHook("onRequest", authenticate({ identity: options.identity, db: options.db }));
    app.addHook("onResponse", auditOnSuccess(options.db));
    registerAuthRoutes(app, { identity: options.identity, db: options.db });
    registerConfigRoutes(app, { identity: options.identity, db: options.db });
  }

  if (options.services !== undefined && options.loadConfig !== undefined) {
    registerAssetRoutes(app, { services: options.services, loadConfig: options.loadConfig });
    registerVerifyRoutes(app, { services: options.services, loadConfig: options.loadConfig });
  }

  app.addHook("onResponse", (request, reply, done) => {
    telemetry.counter("http.requests", 1, {
      method: request.method,
      status: reply.statusCode,
    });
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

  app.get("/v1/health", (_request: FastifyRequest, reply: FastifyReply) => {
    const body: HealthResponse = {
      status: "ok",
      service: "tpirs",
      region: config.deploymentRegion,
      version: VERSION,
    };
    void reply.send(body);
  });

  app.get("/v1/ready", async (_request: FastifyRequest, reply: FastifyReply) => {
    const ready = options.readiness === undefined ? true : await options.readiness();
    const body: ReadyResponse = { status: ready ? "ready" : "not_ready" };
    void reply.code(ready ? 200 : 503).send(body);
  });

  return app;
}
