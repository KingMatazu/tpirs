import { createOtelTelemetry } from "@tpirs/adapters-otel-telemetry";
import { createDefaultWorker } from "./worker.js";

const telemetry = createOtelTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "tpirs-worker",
});
const { worker, db } = createDefaultWorker();

const shutdown = (signal: string): void => {
  telemetry.log("info", `received ${signal}, shutting down`);
  worker
    .stop()
    .then(() => db.destroy())
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      telemetry.captureError(error, { stage: "shutdown" });
      process.exit(1);
    });
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

worker.start().catch((error: unknown) => {
  telemetry.captureError(error, { stage: "startup" });
  process.exit(1);
});
