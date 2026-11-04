import { describe, expect, it } from "vitest";
import { resolveTenantFeeMinor } from "./tenantFee.js";
import { loadFixtureConfig } from "../test-support/tenant.js";

/**
 * The dashboard must show the amount the API will check, so the fee comes from
 * the tenant's fee engine rather than a second reading of the rule list. These
 * tests pin the three answers the cash screen depends on: a price, "no rule",
 * and a rule that has expired.
 */

const config = loadFixtureConfig();

describe("resolveTenantFeeMinor", () => {
  it("returns the tenant's fee for an asset type today", async () => {
    expect(await resolveTenantFeeMinor(config, "bike", "2026-11-03")).toBe(20000n);
  });

  it("returns undefined for an asset type the tenant has not priced", async () => {
    expect(await resolveTenantFeeMinor(config, "market-stall", "2026-11-03")).toBeUndefined();
  });

  it("returns undefined before a rule takes effect", async () => {
    expect(await resolveTenantFeeMinor(config, "bike", "2025-12-31")).toBeUndefined();
  });

  it("respects an end date, which the old rule-list reading ignored", async () => {
    const ended = {
      ...config,
      obligations: {
        ...config.obligations,
        feeRules: [
          {
            key: "bike-old",
            assetTypeKey: "bike",
            amountMinor: 10000,
            effectiveFrom: "2026-01-01",
            effectiveTo: "2026-06-30",
          },
          {
            key: "bike-new",
            assetTypeKey: "bike",
            amountMinor: 20000,
            effectiveFrom: "2026-07-01",
          },
        ],
      },
    };
    expect(await resolveTenantFeeMinor(ended, "bike", "2026-05-01")).toBe(10000n);
    expect(await resolveTenantFeeMinor(ended, "bike", "2026-11-03")).toBe(20000n);
  });
});
