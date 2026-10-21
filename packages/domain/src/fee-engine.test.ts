import { describe, expect, it } from "vitest";
import { businessDate } from "./business-date.js";
import { computeFee, resolveFeeRule, FeeRuleNotFoundError } from "./fee-engine.js";

describe("fee-engine", () => {
  const rules = [
    {
      key: "bike-old",
      assetTypeKey: "bike",
      amountMinor: 100,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-06-30",
    },
    {
      key: "bike-new",
      assetTypeKey: "bike",
      amountMinor: 150,
      effectiveFrom: "2026-07-01",
    },
    {
      key: "tuktuk-flat",
      assetTypeKey: "tuktuk",
      amountMinor: 200,
      effectiveFrom: "2026-01-01",
    },
  ];

  it("resolves the effective rule for a date range", () => {
    expect(resolveFeeRule(rules, "bike", businessDate("2026-03-01"))?.key).toBe("bike-old");
    expect(resolveFeeRule(rules, "bike", businessDate("2026-07-01"))?.key).toBe("bike-new");
    expect(resolveFeeRule(rules, "bike", businessDate("2026-12-31"))?.key).toBe("bike-new");
  });

  it("computes fee for per-type rules", () => {
    const result = computeFee({
      rules,
      assetTypeKey: "tuktuk",
      businessDate: businessDate("2026-05-01"),
      currency: "NGN",
    });
    expect(result.amount.amount).toBe(200);
    expect(result.ruleKey).toBe("tuktuk-flat");
    expect(result.feeAmountSnapshotMinor).toBe(200);
  });

  it("throws when no rule matches", () => {
    expect(() =>
      computeFee({
        rules,
        assetTypeKey: "truck",
        businessDate: businessDate("2026-01-01"),
        currency: "NGN",
      }),
    ).toThrow(FeeRuleNotFoundError);
  });
});
