import { describe, expect, it } from "vitest";
import {
  LedgerInvariantError,
  STANDARD_ACCOUNTS,
  validateBalancedTransaction,
  type LedgerPosting,
} from "./ledger.js";
import { money } from "./money.js";

function posting(
  accountCode: string,
  direction: "debit" | "credit",
  amount: number,
  currency = "NGN",
): LedgerPosting {
  return { accountCode, direction, amount: money(currency, amount) };
}

describe("ledger", () => {
  it("accepts a balanced transaction", () => {
    expect(() =>
      validateBalancedTransaction([
        posting("GATEWAY_CLEARING", "debit", 500),
        posting("ASSET_WALLET", "credit", 500),
      ]),
    ).not.toThrow();
  });

  it("accepts a multi-posting balanced transaction", () => {
    expect(() =>
      validateBalancedTransaction([
        posting("GATEWAY_CLEARING", "debit", 1000),
        posting("ASSET_WALLET", "credit", 600),
        posting("SUSPENSE", "credit", 400),
      ]),
    ).not.toThrow();
  });

  it("rejects an unbalanced transaction", () => {
    expect(() =>
      validateBalancedTransaction([
        posting("GATEWAY_CLEARING", "debit", 500),
        posting("ASSET_WALLET", "credit", 400),
      ]),
    ).toThrow(LedgerInvariantError);
  });

  it("rejects a single-posting transaction", () => {
    expect(() => validateBalancedTransaction([posting("ASSET_WALLET", "credit", 100)])).toThrow(
      LedgerInvariantError,
    );
  });

  it("rejects mixed currencies", () => {
    expect(() =>
      validateBalancedTransaction([
        posting("GATEWAY_CLEARING", "debit", 500, "NGN"),
        posting("ASSET_WALLET", "credit", 500, "USD"),
      ]),
    ).toThrow(LedgerInvariantError);
  });

  it("rejects non-positive amounts", () => {
    expect(() =>
      validateBalancedTransaction([
        posting("GATEWAY_CLEARING", "debit", 0),
        posting("ASSET_WALLET", "credit", 0),
      ]),
    ).toThrow(LedgerInvariantError);
  });

  it("property: any balanced pair passes, any imbalanced pair fails", () => {
    for (let i = 1; i <= 200; i++) {
      const debit = i * 7;
      const credit = i * 7;
      expect(() =>
        validateBalancedTransaction([
          posting("GATEWAY_CLEARING", "debit", debit),
          posting("ASSET_WALLET", "credit", credit),
        ]),
      ).not.toThrow();
      expect(() =>
        validateBalancedTransaction([
          posting("GATEWAY_CLEARING", "debit", debit),
          posting("ASSET_WALLET", "credit", credit + 1),
        ]),
      ).toThrow(LedgerInvariantError);
    }
  });

  it("exposes the standard chart of accounts", () => {
    const codes = STANDARD_ACCOUNTS.map((a) => a.code);
    expect(codes).toEqual([
      "ASSET_WALLET",
      "REVENUE_LEVY",
      "GATEWAY_CLEARING",
      "SETTLEMENT_BANK",
      "SUSPENSE",
      "COLLECTOR_CASH",
      "GATEWAY_FEES",
    ]);
  });
});
