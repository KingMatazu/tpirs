import { writeFile } from "node:fs/promises";

/**
 * D28: emits the OpenAPI document from the built API (the server is the
 * contract). The app is constructed in-process with mock identity and stub
 * services so every route registers its schema without touching a database,
 * then `swagger()` is dumped to openapi.json for `openapi-typescript`.
 */
import { buildApp } from "@tpirs/api/app";
import { createMockIdentityProvider } from "@tpirs/identity-provider-mock";
import { createMockTelemetry } from "@tpirs/telemetry-mock";

const app = await buildApp({
  config: {
    nodeEnv: "generate",
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    deploymentRegion: "generate",
    databaseUrl: "",
  },
  telemetry: createMockTelemetry(),
  identity: createMockIdentityProvider(),
  // Routes only capture these by reference at registration; no request runs.
  db: /** @type {any} */ ({}),
  services: /** @type {any} */ ({ asset: {}, owner: {}, otp: {}, payment: {}, qrSigner: {} }),
  loadConfig: async () => undefined,
});
await app.ready();

const spec = app.swagger();
await writeFile(new URL("../openapi.json", import.meta.url), `${JSON.stringify(spec, null, 2)}\n`);
await app.close();
console.log(`openapi.json written with ${Object.keys(spec.paths ?? {}).length} paths`);
