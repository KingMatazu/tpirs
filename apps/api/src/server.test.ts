import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./build-app.js";
import type { AppConfig } from "./config.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createPrometheusTelemetry } from "@tpirs/adapters-prometheus-telemetry";
import { LOG_REDACT_PATHS } from "./build-app.js";
import { clientErrorMessage, isSchemaDrift, SCHEMA_DRIFT_MESSAGE, sqlState } from "./errors.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  deploymentRegion: "test",
  databaseUrl: "",
  metricsEnabled: false,
};

describe("api server", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ config, telemetry: createMockTelemetry() });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns health with region and request id", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(response.json()).toMatchObject({ status: "ok", region: "test" });
  });

  it("adds no CORS headers unless origins are configured", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/health",
      headers: {
        origin: "https://admin.example.gov",
        "access-control-request-method": "GET",
      },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight for a configured split-origin deployment", async () => {
    const split = await buildApp({
      config: { ...config, corsOrigins: ["https://admin.example.gov"] },
      telemetry: createMockTelemetry(),
    });
    await split.ready();
    try {
      const response = await split.inject({
        method: "OPTIONS",
        url: "/v1/health",
        headers: {
          origin: "https://admin.example.gov",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization,idempotency-key",
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("https://admin.example.gov");
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-headers"]).toContain("idempotency-key");
    } finally {
      await split.close();
    }
  });

  it("returns ready when the readiness probe passes", async () => {
    const ready = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      readiness: () => Promise.resolve(true),
    });
    await ready.ready();
    const response = await ready.inject({ method: "GET", url: "/v1/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await ready.close();
  });

  it("returns 503 when the readiness probe fails", async () => {
    const notReady = await buildApp({
      config,
      telemetry: createMockTelemetry(),
      readiness: () => Promise.resolve(false),
    });
    await notReady.ready();
    const response = await notReady.inject({ method: "GET", url: "/v1/ready" });
    expect(response.statusCode).toBe(503);
    await notReady.close();
  });

  it("sets the security headers on every response, including errors", async () => {
    for (const url of ["/v1/health", "/v1/does-not-exist"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
      // HSTS only over HTTPS: the test config is not production.
      expect(response.headers["strict-transport-security"]).toBeUndefined();
    }
  });

  it("never echoes an internal message to the client", () => {
    const error = new Error('invalid input syntax for type uuid: "dfgjgh"');
    // 4xx explains itself; 5xx does not, because the text is SQL, table names or
    // internal state.
    expect(clientErrorMessage(error, 400)).toContain("invalid input syntax");
    expect(clientErrorMessage(error, 500)).toBe("Internal server error");
    expect(clientErrorMessage(error, 503)).toBe("Internal server error");
  });

  it("recognises a database that is behind the build, and says how to fix it", () => {
    // What the driver throws for a column or table this build expects and the
    // database does not have yet, including when it arrives wrapped.
    const missingColumn = Object.assign(new Error("column u.zone_id does not exist"), {
      code: "42703",
    });
    expect(isSchemaDrift(missingColumn)).toBe(true);
    expect(isSchemaDrift(new Error("boom", { cause: missingColumn }))).toBe(true);
    // A real fault is not dressed up as a migration problem.
    expect(isSchemaDrift(new Error("connection terminated"))).toBe(false);
    expect(isSchemaDrift(Object.assign(new Error("timeout"), { code: "57014" }))).toBe(false);
    expect(sqlState({ code: "not-a-sqlstate" })).toBeUndefined();
    expect(SCHEMA_DRIFT_MESSAGE).toContain("migrate up");
  });

  it("redacts credentials from anything the logger serialises", () => {
    expect([...LOG_REDACT_PATHS]).toEqual(
      expect.arrayContaining([
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "req.body.password",
        "req.body.totpCode",
        "req.body.refreshToken",
      ]),
    );
  });

  it("does not expose /metrics unless it is enabled", async () => {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(404);
  });

  it("renders prometheus metrics when enabled", async () => {
    const metrics = createPrometheusTelemetry();
    const withMetrics = await buildApp({
      config: { ...config, metricsEnabled: true },
      telemetry: metrics,
      metrics,
    });
    await withMetrics.ready();

    await withMetrics.inject({ method: "GET", url: "/v1/health" });
    await withMetrics.inject({ method: "GET", url: "/v1/health" });
    const response = await withMetrics.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const body = response.body;
    expect(body).toContain("# TYPE http_requests_total counter");
    expect(body).toContain('http_requests_total{method="GET",route="/v1/health",status="200"}');
    expect(body).toContain('http_request_duration_seconds_count{method="GET",route="/v1/health"}');
    // The label is the route pattern, never a resolved path or a token.
    expect(body).not.toContain("/v1/health?");
    await withMetrics.close();
  });

  it("uses the error envelope for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});
