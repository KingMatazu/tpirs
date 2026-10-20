import { describe, expect, it } from "vitest";
import { createSecretsProviderConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createEnvSecretsProvider } from "./index.js";
import { conformanceFixtures } from "@tpirs/contracts";

createSecretsProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createEnvSecretsProvider({
    env: { CONFORMANCE_SECRET: conformanceFixtures.secretValue },
    mapping: { [conformanceFixtures.secretRef]: "CONFORMANCE_SECRET" },
  }),
}));

describe("createEnvSecretsProvider", () => {
  it("uses an explicit mapping override", async () => {
    const secrets = createEnvSecretsProvider({
      env: { MY_KEY: "mapped-value" },
      mapping: { "custom/ref": "MY_KEY" },
    });
    expect(await secrets.getSecret("custom/ref")).toBe("mapped-value");
  });

  it("rejects unknown refs with a not_found PortError", async () => {
    const secrets = createEnvSecretsProvider({ env: {} });
    const error = await secrets.getSecret("missing/ref").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("not_found");
  });
});
