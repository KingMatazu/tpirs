import { buildApp } from "./server.js";
import type { AppConfig } from "./config.js";
import type { Services } from "./services.js";
import { buildServices, makeTenantConfigLoader } from "./services.js";
import { buildObjectStorage } from "./storage.js";
import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import { createPrometheusTelemetry } from "@tpirs/adapters-prometheus-telemetry";
import { createPaystackPaymentProvider } from "@tpirs/payment-provider-paystack";
import { createRemitaPaymentProvider } from "@tpirs/payment-provider-remita";
import { createEnvSecretsProvider } from "@tpirs/adapters-env-secrets";
import { createMockCache } from "@tpirs/cache-mock";
import type { Cache } from "@tpirs/ports";
import { createMockClock } from "@tpirs/clock-mock";
import { createMockLockService } from "@tpirs/lock-service-mock";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import { createDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";
import { createCsvExportService } from "@tpirs/export-service-csv";
import { createPdfExportService } from "@tpirs/export-service-pdf";
import { createXlsxExportService } from "@tpirs/export-service-xlsx";
import { createCsvSettlementImport } from "@tpirs/settlement-import-csv";

const QR_KEY_REF = "qr-token-signing-key";

/**
 * A cache that never counts, so the abuse limiter always allows. Used only by
 * load runs (`LOAD_TEST_DISABLE_RATE_LIMITS=true`) and only outside production:
 * a budget must measure the route, not the throttle that protects it. There is
 * no production path to this function.
 */
function createNoLimitCache(): Cache {
  return {
    get: () => Promise.resolve(0),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
}

function loadConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    host: process.env.API_HOST ?? "0.0.0.0",
    port: Number(process.env.API_PORT ?? "3000"),
    logLevel: process.env.LOG_LEVEL ?? "info",
    deploymentRegion: process.env.DEPLOYMENT_REGION ?? "local",
    databaseUrl: process.env.DATABASE_URL ?? "",
    metricsEnabled: process.env.METRICS_ENABLED === "true",
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Metrics first, console logs underneath (ADR 0042). Spans are not forwarded:
  // a per-request span would add a JSON line to stdout on every call, while its
  // duration still lands in the histogram.
  const consoleTelemetry = createOtelTelemetry({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "tpirs",
  });
  const metrics = createPrometheusTelemetry({
    forward: consoleTelemetry,
    forwardSpans: false,
  });
  const telemetry = metrics;
  const objectStorage = buildObjectStorage(process.env);
  telemetry.log("info", "object storage adapter ready", {
    adapter: process.env.OBJECT_STORAGE_ADAPTER ?? "s3",
  });

  const requireTotp = process.env.REQUIRE_STAFF_TOTP === "true";
  const db =
    config.databaseUrl === "" ? undefined : createDb({ connectionString: config.databaseUrl });
  const identity = db === undefined ? undefined : createDbIdentityProvider({ db, requireTotp });
  if (db !== undefined) {
    telemetry.log("info", "identity provider ready", { requireTotp });
  }

  const disableRateLimits =
    config.nodeEnv !== "production" && process.env.LOAD_TEST_DISABLE_RATE_LIMITS === "true";
  const noLimitCache = disableRateLimits ? createNoLimitCache() : undefined;
  if (disableRateLimits) {
    telemetry.log("warn", "rate limits disabled for a load run", { nodeEnv: config.nodeEnv });
  }

  let services: Services | undefined;
  let loadConfigFn: ReturnType<typeof makeTenantConfigLoader> | undefined;
  if (db !== undefined) {
    const secrets = createEnvSecretsProvider();
    try {
      services = await buildServices({
        db,
        objectStorage,
        secrets,
        sms: createMockSmsProvider(),
        cache: noLimitCache ?? createMockCache(),
        locks: createMockLockService(),
        clock: createMockClock(),
        qrKeyRef: QR_KEY_REF,
        // Payment intake needs the adapters the tenant config names. Without
        // them every webhook answers "provider not configured", which is how the
        // load harness found this gap in Phase 10 (Step 11).
        paymentProviders: {
          paystack: createPaystackPaymentProvider(),
          remita: createRemitaPaymentProvider(),
        },
        // Phase 8: a deployment supplies the statement reader and the report
        // renderers; tenants decide their columns, schedule and rules in config.
        settlementReader: createCsvSettlementImport(),
        exporters: {
          csv: createCsvExportService(),
          pdf: createPdfExportService(),
          xlsx: createXlsxExportService(),
        },
      });
      loadConfigFn = makeTenantConfigLoader(db);
      telemetry.log("info", "registry services ready");
    } catch (error) {
      telemetry.captureError(error, { stage: "services" });
      telemetry.log("warn", "registry services unavailable; asset routes disabled");
    }
  }

  const app = await buildApp({
    config,
    telemetry,
    objectStorage,
    ...(db === undefined ? {} : { db }),
    ...(identity === undefined ? {} : { identity }),
    ...(services === undefined ? {} : { services }),
    ...(services === undefined ? {} : { rateLimiter: services.rateLimiter }),
    ...(loadConfigFn === undefined ? {} : { loadConfig: loadConfigFn }),
    metrics,
    readiness: async () => {
      if (db === undefined) return true;
      try {
        await db.selectFrom("tenants").select("id").limit(1).execute();
        return true;
      } catch {
        return false;
      }
    },
  });

  const shutdown = (signal: string): void => {
    telemetry.log("info", `received ${signal}, shutting down`);
    app.close().then(
      async () => {
        if (db !== undefined) await db.destroy();
        process.exit(0);
      },
      (error: unknown) => {
        telemetry.captureError(error);
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await app.listen({ host: config.host, port: config.port });
  telemetry.log("info", "api listening", { host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
