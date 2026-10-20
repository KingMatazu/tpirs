import { buildApp } from "./server.js";
import type { AppConfig } from "./config.js";
import { buildObjectStorage } from "./storage.js";
import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import { createDb } from "@tpirs/db";
import { createDbIdentityProvider } from "@tpirs/identity-provider-db";

function loadConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    host: process.env.API_HOST ?? "0.0.0.0",
    port: Number(process.env.API_PORT ?? "3000"),
    logLevel: process.env.LOG_LEVEL ?? "info",
    deploymentRegion: process.env.DEPLOYMENT_REGION ?? "local",
    databaseUrl: process.env.DATABASE_URL ?? "",
  };
}

const config = loadConfig();
const telemetry = createOtelTelemetry({ serviceName: process.env.OTEL_SERVICE_NAME ?? "tpirs" });
const objectStorage = buildObjectStorage(process.env);
telemetry.log("info", "object storage adapter ready", {
  adapter: process.env.OBJECT_STORAGE_ADAPTER ?? "s3",
});

const requireTotp = process.env.REQUIRE_STAFF_TOTP === "true";
const db = config.databaseUrl === "" ? undefined : createDb({ connectionString: config.databaseUrl });
const identity = db === undefined ? undefined : createDbIdentityProvider({ db, requireTotp });
if (db !== undefined) {
  telemetry.log("info", "identity provider ready", { requireTotp });
}

const app = buildApp({
  config,
  telemetry,
  objectStorage,
  ...(db === undefined ? {} : { db }),
  ...(identity === undefined ? {} : { identity }),
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

app
  .listen({ host: config.host, port: config.port })
  .then(() => {
    telemetry.log("info", "api listening", { host: config.host, port: config.port });
  })
  .catch((error: unknown) => {
    telemetry.captureError(error);
    process.exit(1);
  });
