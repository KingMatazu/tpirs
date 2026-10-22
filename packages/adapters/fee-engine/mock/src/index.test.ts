import { describe, expect, it } from "vitest";
import { createFeeEngineConformanceSuite } from "@tpirs/contracts";
import { assetTypeId, businessDate, tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import { createMockFeeEngine } from "./index.js";

createFeeEngineConformanceSuite({ describe, it, expect }, () => ({ port: createMockFeeEngine() }));

describe("createMockFeeEngine effective dating", () => {
  it("picks the latest rule effective on or before the date", async () => {
    const feeEngine = createMockFeeEngine();
    feeEngine.addRule({
      tenantId: "conformance-tenant",
      assetTypeId: "bike",
      amountMinor: 7500,
      currency: "NGN",
      effectiveFrom: "2026-06-01",
      ruleId: "mock-fee-bike-v2",
    });

    const before = await feeEngine.resolveFee({
      tenantId: tenantId("conformance-tenant"),
      assetType: assetTypeId("bike"),
      businessDate: businessDate("2026-01-01"),
    });
    expect(before.ruleId).toBe("mock-fee-bike");
    expect(before.amountMinor).toBe(5000);

    const after = await feeEngine.resolveFee({
      tenantId: tenantId("conformance-tenant"),
      assetType: assetTypeId("bike"),
      businessDate: businessDate("2026-07-01"),
    });
    expect(after.ruleId).toBe("mock-fee-bike-v2");
    expect(after.amountMinor).toBe(7500);
  });

  it("rejects an unknown asset type with PortError not_found", async () => {
    const feeEngine = createMockFeeEngine();
    await expect(
      feeEngine.resolveFee({
        tenantId: tenantId("conformance-tenant"),
        assetType: assetTypeId("no-such-type"),
        businessDate: businessDate("2026-01-01"),
      }),
    ).rejects.toThrow(PortError);
  });
});
