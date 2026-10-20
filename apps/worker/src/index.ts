import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";

const telemetry = createOtelTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "tpirs-worker",
});

telemetry.log("info", "worker started (Phase 0 stub: no queues registered yet)");

const shutdown = (signal: string): void => {
  telemetry.log("info", `received ${signal}, shutting down`);
  process.exit(0);
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
