import { describe, expect, it } from "vitest";
import { businessDate } from "./business-date.js";
import { compareObligationsForAllocation, obligationPeriodKey } from "./obligation.js";
import { selectFeeRule } from "./fee-engine.js";
import type { FeeRule } from "./fee-engine.js";

describe("allocation (phase 3 requirements)", () => {
  it("pay_per_use: period key derived from business date", () => {
    const bd = businessDate("2026-03-15");
    expect(obligationPeriodKey(bd)).toBe("2026-03-15");
  });

  it("allocation order is oldest-first by period date", () => {
    const a = {
      periodStartDate: "2026-01-01",
      priority: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "1",
    };
    const b = {
      periodStartDate: "2026-01-02",
      priority: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "2",
    };
    expect(compareObligationsForAllocation(a, b)).toBeLessThan(0);
  });

  it("fee changes across effective dates are resolved correctly", () => {
    const rules: FeeRule[] = [
      {
        ruleId: "r1",
        assetType: "bike",
        amountMinor: 100,
        currency: "NGN",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      },
      {
        ruleId: "r2",
        assetType: "bike",
        amountMinor: 150,
        currency: "NGN",
        effectiveFrom: "2026-07-01",
      },
    ];
    const oldFee = selectFeeRule(rules, {
      assetType: "bike",
      businessDate: businessDate("2026-05-01"),
    });
    const newFee = selectFeeRule(rules, {
      assetType: "bike",
      businessDate: businessDate("2026-07-01"),
    });
    expect(oldFee?.rule.amountMinor).toBe(100);
    expect(newFee?.rule.amountMinor).toBe(150);
  });
});
