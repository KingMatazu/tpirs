import Fastify from "fastify";
import { buildApp, fastifyOptions } from "./build-app.js";
import type { AppConfig } from "./config.js";
import type { Services } from "./services.js";
import { buildServices, makeTenantConfigLoader } from "./services.js";
import { buildObjectStorage } from "./storage.js";
import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import { createPrometheusTelemetry } from "@tpirs/adapters-prometheus-telemetry";
import { createPaystackPaymentProvider } from "@tpirs/payment-provider-paystack";
import { createMockPaymentProvider } from "@tpirs/payment-provider-mock";
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
/** Where the Paystack integration secret lives; never read from the env directly. */
const PAYSTACK_SECRET_REF = "payments/paystack/secret-key";

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

function list(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function cookieSameSite(): "strict" | "lax" | "none" {
  const value = (process.env.REFRESH_COOKIE_SAMESITE ?? "strict").trim().toLowerCase();
  if (value === "lax" || value === "none" || value === "strict") return value;
  throw new Error(`REFRESH_COOKIE_SAMESITE must be strict, lax or none (received "${value}")`);
}

function loadConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    host: process.env.API_HOST ?? "0.0.0.0",
    // Vercel (and most container platforms) inject PORT; API_PORT remains the
    // local/CI setting so a developer's .env keeps working.
    port: Number(process.env.PORT ?? process.env.API_PORT ?? "3000"),
    logLevel: process.env.LOG_LEVEL ?? "info",
    deploymentRegion: process.env.DEPLOYMENT_REGION ?? "local",
    databaseUrl: process.env.DATABASE_URL ?? "",
    metricsEnabled: process.env.METRICS_ENABLED === "true",
    corsOrigins: list(process.env.CORS_ORIGINS),
    refreshCookieSameSite: cookieSameSite(),
    ...(process.env.SETUP_TOKEN === undefined || process.env.SETUP_TOKEN.trim() === ""
      ? {}
      : { setupToken: process.env.SETUP_TOKEN.trim() }),
    trustProxy: process.env.TRUST_PROXY === "true",
    devTools: process.env.DEV_TOOLS_ENABLED === "true",
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
  if (config.devTools === true && config.nodeEnv === "production") {
    // Loud on purpose: this route can credit a collector's wallet without money
    // arriving, so a live deployment must never carry it.
    telemetry.log(
      "warn",
      "DEV_TOOLS_ENABLED is on in production: wallet simulation can mint float",
      {
        setting: "DEV_TOOLS_ENABLED",
      },
    );
  }
  const objectStorage = buildObjectStorage(process.env);
  telemetry.log("info", "object storage adapter ready", {
    adapter: process.env.OBJECT_STORAGE_ADAPTER ?? "s3",
  });

  const requireTotp = process.env.REQUIRE_STAFF_TOTP === "true";
  // A serverless instance should hold one connection, not ten: the pooled
  // Supabase/PgBouncer URL multiplexes many instances onto few backends.
  const poolMax = Number(process.env.DB_POOL_MAX ?? "10");
  const db =
    config.databaseUrl === ""
      ? undefined
      : createDb({
          connectionString: config.databaseUrl,
          ...(Number.isFinite(poolMax) && poolMax > 0 ? { maxConnections: poolMax } : {}),
        });
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
    // Paystack's secret key doubles as the webhook signing secret. Anchor, the
    // mount and tax onboarding all read Paystack's `FA`-prefixed keys; ours is a
    // normal integration key. Missing is not fatal: webhooks are refused and
    // terminal provisioning fails loudly rather than trusting unsigned input.
    const paystackSecret = await secrets.getSecret(PAYSTACK_SECRET_REF).catch(() => undefined);
    if (paystackSecret === undefined) {
      telemetry.log(
        "warn",
        "paystack secret is not set; terminal funding and webhooks are disabled",
        {
          env: "SECRET_PAYMENTS_PAYSTACK_SECRET_KEY",
        },
      );
    }
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
        // Printed stickers point their QR at the public verification page once a
        // deployment has one; unset keeps the bare opaque token (ADR 0067).
        ...(process.env.PUBLIC_VERIFY_BASE_URL === undefined ||
        process.env.PUBLIC_VERIFY_BASE_URL.trim() === ""
          ? {}
          : { publicVerifyBaseUrl: process.env.PUBLIC_VERIFY_BASE_URL.trim() }),
        // Payment intake needs the adapters the tenant config names. Without
        // them every webhook answers "provider not configured", which is how the
        // load harness found this gap in Phase 10 (Step 11).
        paymentProviders: {
          paystack: createPaystackPaymentProvider({
            ...(paystackSecret === undefined
              ? {}
              : { secretKey: paystackSecret, webhookSecret: paystackSecret }),
            ...(process.env.PAYSTACK_DEFAULT_EMAIL === undefined ||
            process.env.PAYSTACK_DEFAULT_EMAIL.trim() === ""
              ? {}
              : { defaultEmail: process.env.PAYSTACK_DEFAULT_EMAIL.trim() }),
            ...(process.env.PAYSTACK_BASE_URL === undefined ||
            process.env.PAYSTACK_BASE_URL.trim() === ""
              ? {}
              : { baseUrl: process.env.PAYSTACK_BASE_URL.trim() }),
          }),
          remita: createRemitaPaymentProvider(),
          // Local and demo deployments only. Paystack's Test Mode cannot issue
          // a Virtual Terminal NUBAN ("titan-paystack is not available in test
          // mode"), so the terminal flow is exercised against the mock adapter
          // by binding the tenant to `mock`. A production build does not
          // register it, so no stored config can select it there.
          ...(config.nodeEnv === "production" ? {} : { mock: createMockPaymentProvider() }),
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
    // Created here so Vercel's zero-config Fastify detector sees this entrypoint
    // import and use `fastify` (see fastifyOptions).
    fastify: Fastify(fastifyOptions(config)),
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
