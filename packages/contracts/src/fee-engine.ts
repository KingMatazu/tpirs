import { assetTypeId, businessDate, tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { FeeEngine } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/** Factories must quote a positive amount in conformanceFixtures.currency for
 *  asset type conformanceFixtures.assetTypeKey on 2026-01-01. */
export function createFeeEngineConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<FeeEngine>,
): void {
  const { describe, it, expect } = harness;

  describe("FeeEngine conformance", () => {
    it("quotes a positive amount for the fixture asset type", () =>
      withAdapter(factory, async (feeEngine) => {
        const quote = await feeEngine.quote({
          tenantId: tenantId("conformance-tenant"),
          assetTypeId: assetTypeId(conformanceFixtures.assetTypeKey),
          date: businessDate("2026-01-01"),
        });
        expect(quote.amount.currency).toBe(conformanceFixtures.currency);
        expect(quote.amount.amount).toBeGreaterThan(0);
        expect(quote.ruleId.length > 0).toBe(true);
      }));

    it("throws PortError not_found for unknown asset types", () =>
      withAdapter(factory, async (feeEngine) => {
        await expect(
          feeEngine.quote({
            tenantId: tenantId("conformance-tenant"),
            assetTypeId: assetTypeId("no-such-type"),
            date: businessDate("2026-01-01"),
          }),
        ).rejects.toThrow(PortError);
      }));
  });
}
