import { tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { AssetSchemaRegistry } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/** Factories must register asset type conformanceFixtures.assetTypeKey with a required
 *  string attribute conformanceFixtures.requiredAttributeKey. */
export function createAssetSchemaRegistryConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<AssetSchemaRegistry>,
): void {
  const { describe, it, expect } = harness;

  describe("AssetSchemaRegistry conformance", () => {
    it("lists asset types for a tenant", () =>
      withAdapter(factory, async (registry) => {
        const types = await registry.listTypes(tenantId("conformance-tenant"));
        expect(types.length).toBeGreaterThan(0);
        expect(types.some((t) => t.key === conformanceFixtures.assetTypeKey)).toBe(true);
      }));

    it("gets a type by key", () =>
      withAdapter(factory, async (registry) => {
        const type = await registry.getType(
          tenantId("conformance-tenant"),
          conformanceFixtures.assetTypeKey,
        );
        expect(type.key).toBe(conformanceFixtures.assetTypeKey);
        expect(
          type.attributes.some((a) => a.key === conformanceFixtures.requiredAttributeKey),
        ).toBe(true);
      }));

    it("throws PortError not_found for unknown types", () =>
      withAdapter(factory, async (registry) => {
        await expect(
          registry.getType(tenantId("conformance-tenant"), "no-such-type"),
        ).rejects.toThrow(PortError);
      }));

    it("validates attributes against the schema", () =>
      withAdapter(factory, async (registry) => {
        const missing = await registry.validateAttributes(
          tenantId("conformance-tenant"),
          conformanceFixtures.assetTypeKey,
          {},
        );
        expect(missing.ok).toBe(false);
        expect(
          missing.errors.some((e) => e.attribute === conformanceFixtures.requiredAttributeKey),
        ).toBe(true);

        const valid = await registry.validateAttributes(
          tenantId("conformance-tenant"),
          conformanceFixtures.assetTypeKey,
          { [conformanceFixtures.requiredAttributeKey]: "ABC-123" },
        );
        expect(valid.ok).toBe(true);
      }));
  });
}
