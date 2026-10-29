import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { feeSplit, isWithinTolerance, settlementFeePostings } from "./reconciliation.js";
import { ReconciliationError } from "./reconciliation.js";
import { validateBalancedTransaction } from "./ledger.js";
import { GATEWAY_FEES_ACCOUNT, GATEWAY_CLEARING_ACCOUNT } from "./reconciliation.js";
import { money } from "./money.js";
import { checkProperty } from "./test-support/property.js";

/**
 * Properties for the Phase 8 fee-leg arithmetic (ADR 0036).
 *
 * The ledger stays balanced per transaction, so a whole day of settlement
 * postings is balanced too: every row moves `payment` out of clearing as
 * `bank + fee`, and debits equal credits for the day by construction.
 */

const paymentAndBankArb = fc
  .record({
    payment: fc.bigInt({ min: 1n, max: 1_000_000n }),
    bank: fc.bigInt({ min: 0n, max: 1_000_000n }),
  })
  .filter(({ payment, bank }) => bank <= payment);

describe("settlement fee leg properties", () => {
  it("keeps bank + fee equal to payment for every admissible split", () => {
    checkProperty(
      "bank + fee = payment",
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (payment, bank) => {
          if (bank > payment) return;
          const split = feeSplit({
            paymentMinor: payment,
            bankMinor: bank,
            feeToleranceMinor: payment,
          });
          expect(split.bankAmountMinor + split.feeAmountMinor).toBe(split.paymentAmountMinor);
          expect(split.feeAmountMinor >= 0n).toBe(true);
          expect(isWithinTolerance(split.feeAmountMinor, payment)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("posts balanced transactions whose debit total equals the payment credited to clearing", () => {
    checkProperty(
      "settlement postings are balanced, debit total = payment",
      fc.property(paymentAndBankArb, ({ payment, bank }) => {
        const split = feeSplit({
          paymentMinor: payment,
          bankMinor: bank,
          feeToleranceMinor: payment,
        });
        const postings = settlementFeePostings({
          paymentAmount: money("NGN", Number(payment)),
          bankAmount: money("NGN", Number(bank)),
        });
        validateBalancedTransaction(postings);
        const debits = postings
          .filter((posting) => posting.direction === "debit")
          .reduce((sum, posting) => sum + posting.amount.amount, 0);
        expect(BigInt(debits)).toBe(split.paymentAmountMinor);
        expect(BigInt(split.bankAmountMinor) + BigInt(split.feeAmountMinor)).toBe(BigInt(debits));
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every over-settlement and never converts it into fees", () => {
    checkProperty(
      "bank more than charged is rejected as over_settlement",
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (payment, bank) => {
          if (bank <= payment) return;
          expect(() =>
            feeSplit({ paymentMinor: payment, bankMinor: bank, feeToleranceMinor: payment * 10n }),
          ).toThrow(ReconciliationError);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("posts the all-fee case with only fees and clearing legs", () => {
    const postings = settlementFeePostings({
      paymentAmount: money("NGN", 20_000),
      bankAmount: money("NGN", 0),
    });
    expect(postings.map((posting) => posting.accountCode)).toEqual([
      GATEWAY_FEES_ACCOUNT,
      GATEWAY_CLEARING_ACCOUNT,
    ]);
    validateBalancedTransaction(postings);
  });

  it("holds the inclusive tolerance boundary across random amounts", () => {
    checkProperty(
      "tolerance boundary is inclusive",
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (diff, tol) => {
          const expected = diff <= tol;
          expect(isWithinTolerance(BigInt(diff), BigInt(tol))).toBe(expected);
          expect(isWithinTolerance(-BigInt(diff), BigInt(tol))).toBe(expected);
        },
      ),
    );
  });
});
