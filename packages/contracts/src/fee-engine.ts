import { assetTypeId, businessDate, tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import type { FeeEngine } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { conformanceFixtures, withAdapter } from "./harness.js";

/**
 * Shared FeeEngine behaviour.
 *
 * Factories must resolve a positive amount in conformanceFixtures.currency for
 * asset type conformanceFixtures.assetTypeKey on 2026-01-01, must be
 * deterministic, and must reject an unknown tenant.
 *
 * Note on "unknown asset type": that behaviour is deliberately NOT asserted
 * here. A tenant may ship a default rule that prices every asset type, so
 * "unknown asset type" is only an error when no default rule applies. Each
 * adapter asserts its own rule set in its own tests.
 */
export function createFeeEngineConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<FeeEngine>,
): void {
  const { describe, it, expect } = harness;

  describe("FeeEngine conformance", () => {
    it("resolves a positive amount for the fixture asset type", () =>
      withAdapter(factory, async (feeEngine) => {
        const fee = await feeEngine.resolveFee({
          tenantId: tenantId("conformance-tenant"),
          assetType: assetTypeId(conformanceFixtures.assetTypeKey),
          businessDate: businessDate("2026-01-01"),
        });
        expect(fee.currency).toBe(conformanceFixtures.currency);
        expect(Number.isInteger(fee.amountMinor)).toBe(true);
        expect(fee.amountMinor).toBeGreaterThan(0);
      }));

    it("returns a non-empty rule identifier", () =>
      withAdapter(factory, async (feeEngine) => {
        const fee = await feeEngine.resolveFee({
          tenantId: tenantId("conformance-tenant"),
          assetType: assetTypeId(conformanceFixtures.assetTypeKey),
          businessDate: businessDate("2026-01-01"),
        });
        expect(fee.ruleId.length).toBeGreaterThan(0);
      }));

    it("is deterministic for the same request", () =>
      withAdapter(factory, async (feeEngine) => {
        const request = {
          tenantId: tenantId("conformance-tenant"),
          assetType: assetTypeId(conformanceFixtures.assetTypeKey),
          businessDate: businessDate("2026-01-01"),
        };
        const first = await feeEngine.resolveFee(request);
        const second = await feeEngine.resolveFee(request);
        expect(second).toEqual(first);
      }));

    it("rejects an unknown tenant with PortError not_found", () =>
      withAdapter(factory, async (feeEngine) => {
        await expect(
          feeEngine.resolveFee({
            tenantId: tenantId("no-such-tenant"),
            assetType: assetTypeId(conformanceFixtures.assetTypeKey),
            businessDate: businessDate("2026-01-01"),
          }),
        ).rejects.toThrow(PortError);
      }));
  });
}
