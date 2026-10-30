import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./server.js";
import type { AppConfig } from "./config.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";
import { createPrometheusTelemetry } from "@tpirs/adapters-prometheus-telemetry";
import { LOG_REDACT_PATHS } from "./server.js";
import { clientErrorMessage } from "./errors.js";

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
