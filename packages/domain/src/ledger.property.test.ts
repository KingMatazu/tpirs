import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mirrorPostings, validateBalancedTransaction } from "./ledger.js";
import type { LedgerPosting } from "./ledger.js";
import { money } from "./money.js";
import { checkProperty } from "./test-support/property.js";

const currencyArb = fc.constantFrom("NGN", "GHS", "KES");
const accountArb = fc.constantFrom("ASSET_WALLET", "REVENUE_LEVY", "GATEWAY_CLEARING");
const directionArb = fc.constantFrom<"debit" | "credit">("debit", "credit");

const postingArb = fc.record({
  accountCode: accountArb,
  direction: directionArb,
  currency: currencyArb,
  amount: fc.integer({ min: -100_000, max: 1_000_000 }),
});

function toPostings(raw: {
  accountCode: string;
  direction: "debit" | "credit";
  currency: string;
  amount: number;
}): LedgerPosting {
  return {
    accountCode: raw.accountCode,
    direction: raw.direction,
    amount: money(raw.currency, raw.amount),
  };
}

function isAccepted(postings: readonly LedgerPosting[]): boolean {
  if (postings.length < 2) return false;
  const first = postings[0];
  if (first === undefined) return false;
  const currency = first.amount.currency;
  let debits = 0n;
  let credits = 0n;
  for (const posting of postings) {
    if (posting.amount.currency !== currency) return false;
    if (posting.amount.amount <= 0) return false;
    if (posting.direction === "debit") {
      debits += BigInt(posting.amount.amount);
    } else {
      credits += BigInt(posting.amount.amount);
    }
  }
  return debits === credits;
}

/**
 * A balanced transaction in one currency, built by pairing every debit with an
 * equal credit.
 */
const balancedPostingsArb = fc
  .tuple(
    currencyArb,
    fc.array(
      fc.record({
        amount: fc.integer({ min: 1, max: 1_000_000 }),
        debitAccount: accountArb,
        creditAccount: accountArb,
      }),
      { minLength: 1, maxLength: 6 },
    ),
  )
  .map(([currency, pairs]) =>
    pairs.flatMap((pair) => [
      toPostings({
        accountCode: pair.debitAccount,
        direction: "debit",
        currency,
        amount: pair.amount,
      }),
      toPostings({
        accountCode: pair.creditAccount,
        direction: "credit",
        currency,
        amount: pair.amount,
      }),
    ]),
  );

describe("ledger posting properties", () => {
  it("accepts exactly the transactions whose debits equal their credits", () => {
    checkProperty(
      "posting acceptance",
      fc.property(fc.array(postingArb, { minLength: 0, maxLength: 8 }), (raw) => {
        const postings = raw.map(toPostings);
        let accepted = true;
        try {
          validateBalancedTransaction(postings);
        } catch {
          accepted = false;
        }
        expect(accepted).toBe(isAccepted(postings));
      }),
      {
        // `examples` are tuple values, so a single-arbitrary property wraps
        // each example in one more array.
        examples: [
          [
            [
              {
                accountCode: "ASSET_WALLET",
                direction: "debit",
                currency: "NGN",
                amount: 100,
              },
              {
                accountCode: "REVENUE_LEVY",
                direction: "credit",
                currency: "NGN",
                amount: 100,
              },
            ],
          ],
          [
            [
              {
                accountCode: "ASSET_WALLET",
                direction: "debit",
                currency: "NGN",
                amount: 100,
              },
              {
                accountCode: "REVENUE_LEVY",
                direction: "credit",
                currency: "NGN",
                amount: 99,
              },
            ],
          ],
        ],
      },
    );
  });

  it("rejects a transaction that mixes currencies", () => {
    checkProperty(
      "mixed currencies",
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (amount) => {
        const postings: LedgerPosting[] = [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", amount),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("GHS", amount),
          },
        ];
        expect(() => validateBalancedTransaction(postings)).toThrow(/same currency/);
      }),
    );
  });

  it("rejects zero and negative amounts", () => {
    checkProperty(
      "non-positive amounts",
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), (amount) => {
        const postings: LedgerPosting[] = [
          {
            accountCode: "GATEWAY_CLEARING",
            direction: "debit",
            amount: money("NGN", amount),
          },
          {
            accountCode: "ASSET_WALLET",
            direction: "credit",
            amount: money("NGN", amount),
          },
        ];
        expect(() => validateBalancedTransaction(postings)).toThrow(/must be positive/);
      }),
      { examples: [[0], [-1]] },
    );
  });

  it("rejects a transaction with fewer than two postings", () => {
    expect(() =>
      validateBalancedTransaction([
        { accountCode: "GATEWAY_CLEARING", direction: "debit", amount: money("NGN", 100) },
      ]),
    ).toThrow(/at least two postings/);
  });
});

describe("reversal mirroring properties", () => {
  it("mirrors a balanced transaction into another balanced transaction", () => {
    checkProperty(
      "reversal is balanced",
      fc.property(balancedPostingsArb, (postings) => {
        const mirrored = mirrorPostings(postings);
        expect(() => validateBalancedTransaction(mirrored)).not.toThrow();
      }),
    );
  });

  it("nets the reversal to zero against the original for every account", () => {
    checkProperty(
      "reversal nets to zero",
      fc.property(balancedPostingsArb, (postings) => {
        const mirrored = mirrorPostings(postings);
        const net = new Map<string, bigint>();
        for (const posting of [...postings, ...mirrored]) {
          const delta =
            posting.direction === "debit"
              ? BigInt(posting.amount.amount)
              : -BigInt(posting.amount.amount);
          net.set(posting.accountCode, (net.get(posting.accountCode) ?? 0n) + delta);
        }
        for (const [accountCode, balance] of net) {
          expect(balance, `account ${accountCode}`).toBe(0n);
        }
      }),
    );
  });

  it("keeps the total magnitude of the reversal equal to the original", () => {
    checkProperty(
      "reversal magnitude",
      fc.property(balancedPostingsArb, (postings) => {
        const total = (list: readonly LedgerPosting[]): bigint =>
          list.reduce((sum, posting) => sum + BigInt(posting.amount.amount), 0n);
        expect(total(mirrorPostings(postings))).toBe(total(postings));
      }),
    );
  });
});
