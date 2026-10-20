import { describe, expect, it } from "vitest";
import { createSecretsProviderConformanceSuite } from "@tpirs/contracts";
import { createMockSecretsProvider } from "./index.js";

createSecretsProviderConformanceSuite({ describe, it, expect }, () => ({
  port: createMockSecretsProvider(),
}));

describe("createMockSecretsProvider", () => {
  it("supports setting secrets after construction", async () => {
    const secrets = createMockSecretsProvider({});
    secrets.setSecret("db/password", "hunter2");
    expect(await secrets.getSecret("db/password")).toBe("hunter2");
    expect(secrets.refs()).toEqual(["db/password"]);
  });
});
