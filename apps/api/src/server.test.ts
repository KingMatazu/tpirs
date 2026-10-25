import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./server.js";
import type { AppConfig } from "./config.js";
import { createMockTelemetry } from "@tpirs/telemetry-mock";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  deploymentRegion: "test",
  databaseUrl: "",
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

  it("uses the error envelope for unknown routes", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe("not_found");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});
