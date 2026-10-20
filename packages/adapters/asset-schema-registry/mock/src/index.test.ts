import { describe, expect, it } from "vitest";
import { createAssetSchemaRegistryConformanceSuite } from "@tpirs/contracts";
import { createMockAssetSchemaRegistry } from "./index.js";

createAssetSchemaRegistryConformanceSuite({ describe, it, expect }, () => ({
  port: createMockAssetSchemaRegistry(),
}));

describe("createMockAssetSchemaRegistry", () => {
  it("rejects values of the wrong type", async () => {
    const registry = createMockAssetSchemaRegistry();
    const result = await registry.validateAttributes("conformance-tenant", "bike", {
      plate_number: 123,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.attribute === "plate_number")).toBe(true);
  });
});
