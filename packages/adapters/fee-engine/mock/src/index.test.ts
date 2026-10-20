import { describe, expect, it } from "vitest";
import { createFeeEngineConformanceSuite } from "@tpirs/contracts";
import { assetTypeId, businessDate, tenantId } from "@tpirs/domain";
import { createMockFeeEngine } from "./index.js";

createFeeEngineConformanceSuite({ describe, it, expect }, () => ({ port: createMockFeeEngine() }));

describe("createMockFeeEngine effective dating", () => {
  it("picks the latest rule effective on or before the date", async () => {
    const feeEngine = createMockFeeEngine();
    feeEngine.addRule({
      tenantId: "conformance-tenant",
      assetTypeId: "bike",
      amount: 7500,
      currency: "NGN",
      effectiveFrom: "2026-06-01",
      ruleId: "mock-fee-bike-v2",
    });

    const before = await feeEngine.quote({
      tenantId: tenantId("conformance-tenant"),
      assetTypeId: assetTypeId("bike"),
      date: businessDate("2026-01-01"),
    });
    expect(before.ruleId).toBe("mock-fee-bike");

    const after = await feeEngine.quote({
      tenantId: tenantId("conformance-tenant"),
      assetTypeId: assetTypeId("bike"),
      date: businessDate("2026-07-01"),
    });
    expect(after.ruleId).toBe("mock-fee-bike-v2");
    expect(after.amount.amount).toBe(7500);
  });
});
