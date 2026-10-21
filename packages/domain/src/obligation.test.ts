import { describe, expect, it } from "vitest";
import {
  compareObligationsForAllocation,
  obligationPeriodKey,
  canAccrueArrears,
  isPayPerUseEligible,
  type ObligationAllocationKey,
} from "./obligation.js";
import { businessDate } from "./business-date.js";

function key(overrides: Partial<ObligationAllocationKey>): ObligationAllocationKey {
  return {
    periodStartDate: "2026-01-01",
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

describe("obligation", () => {
  it("orders by period start date first", () => {
    const earlier = key({ periodStartDate: "2026-01-01" });
    const later = key({ periodStartDate: "2026-01-02" });
    expect(compareObligationsForAllocation(earlier, later)).toBeLessThan(0);
  });

  it("orders by priority when dates match", () => {
    const low = key({ priority: 1 });
    const high = key({ priority: 5 });
    expect(compareObligationsForAllocation(low, high)).toBeLessThan(0);
  });

  it("orders by creation time when date and priority match", () => {
    const first = key({ createdAt: "2026-01-01T00:00:00.000Z" });
    const second = key({ createdAt: "2026-01-01T00:00:01.000Z" });
    expect(compareObligationsForAllocation(first, second)).toBeLessThan(0);
  });

  it("orders by id as the final tiebreak", () => {
    const a = key({ id: "00000000-0000-0000-0000-000000000001" });
    const b = key({ id: "00000000-0000-0000-0000-000000000002" });
    expect(compareObligationsForAllocation(a, b)).toBeLessThan(0);
  });

  it("is a total order and returns zero for identical keys", () => {
    const k = key({});
    const copy = key({});
    expect(compareObligationsForAllocation(k, copy)).toBe(0);
  });

  it("derives the period key from the business date", () => {
    const bd = businessDate("2026-03-15");
    expect(obligationPeriodKey(bd)).toBe("2026-03-15");
  });

  it("pay_per_use is eligible, scheduled is not", () => {
    expect(isPayPerUseEligible("pay_per_use")).toBe(true);
    expect(isPayPerUseEligible("scheduled")).toBe(false);
  });

  it("only accrue policy accrues arrears", () => {
    expect(canAccrueArrears("accrue")).toBe(true);
    expect(canAccrueArrears("none")).toBe(false);
  });
});
