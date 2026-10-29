import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLEARING_ACCOUNT,
  GATEWAY_FEES_ACCOUNT,
  RECONCILIATION_CHECKS,
  SETTLEMENT_BANK_ACCOUNT,
  assembleChecklist,
  blockingChecklistFailures,
  buildChecklistItem,
  checkSeverity,
  classifyDifference,
  exceptionDedupeKey,
  feeSplit,
  isWithinTolerance,
  ReconciliationError,
  settlementFeePostings,
} from "./reconciliation.js";
import { validateBalancedTransaction } from "./ledger.js";
import { money } from "./money.js";

describe("tolerance comparison", () => {
  it("is inclusive at the boundary", () => {
    expect(isWithinTolerance(5n, 5n)).toBe(true);
    expect(isWithinTolerance(6n, 5n)).toBe(false);
  });

  it("measures negative differences by magnitude", () => {
    expect(isWithinTolerance(-3n, 3n)).toBe(true);
    expect(isWithinTolerance(-4n, 3n)).toBe(false);
  });

  it("refuses a negative tolerance", () => {
    expect(() => isWithinTolerance(0n, -1n)).toThrow(ReconciliationError);
  });

  it("accepts a zero tolerance for exact matches only", () => {
    expect(isWithinTolerance(0n, 0n)).toBe(true);
    expect(isWithinTolerance(1n, 0n)).toBe(false);
  });
});

describe("difference classification", () => {
  it("labels matching, over and short", () => {
    expect(classifyDifference(100n, 100n)).toBe("matched");
    expect(classifyDifference(100n, 120n)).toBe("over");
    expect(classifyDifference(100n, 80n)).toBe("short");
  });
});

describe("fee split", () => {
  it("splits a payment into bank and fee legs", () => {
    const split = feeSplit({
      paymentMinor: 20_000n,
      bankMinor: 19_700n,
      feeToleranceMinor: 500n,
    });
    expect(split.bankAmountMinor).toBe(19_700n);
    expect(split.feeAmountMinor).toBe(300n);
    expect(split.paymentAmountMinor).toBe(20_000n);
  });

  it("accepts a zero fee", () => {
    const split = feeSplit({ paymentMinor: 20_000n, bankMinor: 20_000n, feeToleranceMinor: 0n });
    expect(split.feeAmountMinor).toBe(0n);
  });

  it("refuses an over-settlement before tolerance is consulted", () => {
    try {
      feeSplit({ paymentMinor: 20_000n, bankMinor: 20_100n, feeToleranceMinor: 1_000n });
      expect.unreachable("feeSplit should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ReconciliationError);
      if (error instanceof ReconciliationError) {
        expect(error.code).toBe("over_settlement");
      }
    }
  });

  it("refuses a fee beyond tolerance", () => {
    expect(() =>
      feeSplit({ paymentMinor: 20_000n, bankMinor: 18_000n, feeToleranceMinor: 1_000n }),
    ).toThrow(ReconciliationError);
  });

  it("passes the boundary exactly", () => {
    expect(() =>
      feeSplit({ paymentMinor: 20_000n, bankMinor: 19_000n, feeToleranceMinor: 1_000n }),
    ).not.toThrow();
  });
});

describe("settlement fee postings", () => {
  it("posts the three-leg transaction when a fee exists", () => {
    const postings = settlementFeePostings({
      paymentAmount: money("NGN", 20_000),
      bankAmount: money("NGN", 19_700),
    });
    expect(postings).toHaveLength(3);
    validateBalancedTransaction(postings);
    const accounts = postings.map((posting) => posting.accountCode);
    expect(accounts).toContain(GATEWAY_FEES_ACCOUNT);
    expect(
      postings.find((posting) => posting.accountCode === GATEWAY_FEES_ACCOUNT)?.direction,
    ).toBe("debit");
    expect(
      postings.find((posting) => posting.accountCode === GATEWAY_CLEARING_ACCOUNT)?.direction,
    ).toBe("credit");
  });

  it("omits the fee leg when the gateway charged nothing", () => {
    const postings = settlementFeePostings({
      paymentAmount: money("NGN", 20_000),
      bankAmount: money("NGN", 20_000),
    });
    expect(postings).toHaveLength(2);
    expect(postings.map((posting) => posting.accountCode)).toContain(SETTLEMENT_BANK_ACCOUNT);
    validateBalancedTransaction(postings);
  });

  it("refuses cross-currency postings and over-settlements", () => {
    expect(() =>
      settlementFeePostings({
        paymentAmount: money("NGN", 20_000),
        bankAmount: money("USD", 20_000),
      }),
    ).toThrow(ReconciliationError);
    expect(() =>
      settlementFeePostings({
        paymentAmount: money("NGN", 20_000),
        bankAmount: money("NGN", 20_500),
      }),
    ).toThrow(ReconciliationError);
  });
});

describe("checklist assembly", () => {
  it("orders items by check order, then subject", () => {
    const items = assembleChecklist([
      buildChecklistItem("cash_float", "collector", "z", {
        expectedMinor: 5n,
        actualMinor: 5n,
        toleranceMinor: 0n,
      }),
      buildChecklistItem("settlement_rows_matched", "settlement_row", "b", {
        expectedCount: 0,
        actualCount: 2,
      }),
      buildChecklistItem("settlement_rows_matched", "settlement_row", "a", {
        expectedCount: 0,
        actualCount: 1,
      }),
    ]);
    expect(items.map((item) => [item.check, item.subjectId])).toEqual([
      ["settlement_rows_matched", "a"],
      ["settlement_rows_matched", "b"],
      ["cash_float", "z"],
    ]);
  });

  it("computes differences as actual minus expected and honours an inclusive tolerance", () => {
    const item = buildChecklistItem("clearing_balance", null, null, {
      expectedMinor: 0n,
      actualMinor: 12n,
      toleranceMinor: 12n,
    });
    expect(item.differenceMinor).toBe(12n);
    expect(item.withinTolerance).toBe(true);
    expect(item.severity).toBe("blocking");
  });

  it("leaves withinTolerance null when no tolerance applies", () => {
    const item = buildChecklistItem("cash_overdue", "collector", "c", {
      expectedCount: 0,
      actualCount: 1,
    });
    expect(item.withinTolerance).toBeNull();
    expect(item.differenceCount).toBe(1);
    expect(item.severity).toBe("warning");
  });

  it("lists only blocking failures", () => {
    const warnings = buildChecklistItem("suspense_ageing", "payment", "p", {
      expectedCount: 0,
      actualCount: 1,
    });
    const ok = buildChecklistItem("cash_float", "collector", "c", {
      expectedMinor: 0n,
      actualMinor: 3n,
      toleranceMinor: 3n,
    });
    const bad = buildChecklistItem("clearing_balance", null, null, {
      expectedMinor: 0n,
      actualMinor: 40n,
      toleranceMinor: 3n,
    });
    expect(blockingChecklistFailures([warnings, ok, bad]).map((item) => item.check)).toEqual([
      "clearing_balance",
    ]);
  });

  it("gives every check a known severity and blocks money mismatch", () => {
    expect(checkSeverity("cash_overdue")).toBe("warning");
    expect(checkSeverity("suspense_ageing")).toBe("warning");
    for (const check of RECONCILIATION_CHECKS) {
      if (check !== "cash_overdue" && check !== "suspense_ageing") {
        expect(checkSeverity(check)).toBe("blocking");
      }
    }
  });

  it("builds carry-forward keys that survive re-runs", () => {
    expect(exceptionDedupeKey("cash_float", "collector", "user-1")).toBe(
      "cash_float:collector:user-1",
    );
  });
});
