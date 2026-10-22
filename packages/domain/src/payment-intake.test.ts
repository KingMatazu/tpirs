import { describe, expect, it } from "vitest";
import { decidePaymentIntake } from "./payment-intake.js";
import type { PaymentIntakeInput } from "./payment-intake.js";

function input(overrides: Partial<PaymentIntakeInput> = {}): PaymentIntakeInput {
  return {
    amountMinor: 20_000n,
    currency: "NGN",
    requiredMinor: 20_000n,
    requiredCurrency: "NGN",
    underpaymentPolicy: "wallet",
    alreadyRecorded: false,
    attributable: true,
    dayAlreadySettled: false,
    ...overrides,
  };
}

describe("decidePaymentIntake", () => {
  it("applies an exact payment and leaves nothing in the wallet", () => {
    expect(decidePaymentIntake(input())).toEqual({
      outcome: "applied",
      appliedMinor: 20_000n,
      surplusMinor: 0n,
    });
  });

  it("applies the required part and keeps an overpayment as wallet credit", () => {
    expect(decidePaymentIntake(input({ amountMinor: 25_000n }))).toEqual({
      outcome: "applied",
      appliedMinor: 20_000n,
      surplusMinor: 5_000n,
    });
  });

  it("treats a replay as a no-op before looking at anything else", () => {
    expect(
      decidePaymentIntake(
        input({
          alreadyRecorded: true,
          amountMinor: 1n,
          currency: "USD",
          attributable: false,
        }),
      ),
    ).toEqual({ outcome: "duplicate" });
  });

  it("rejects an amount that is not positive", () => {
    expect(decidePaymentIntake(input({ amountMinor: 0n }))).toEqual({
      outcome: "rejected",
      reason: "non_positive_amount",
    });
    expect(decidePaymentIntake(input({ amountMinor: -1n }))).toEqual({
      outcome: "rejected",
      reason: "non_positive_amount",
    });
  });

  it("sends unattributable money to suspense", () => {
    expect(decidePaymentIntake(input({ attributable: false }))).toEqual({
      outcome: "suspense",
      reason: "unattributable",
    });
  });

  it("sends a currency mismatch to suspense whatever the underpayment policy is", () => {
    for (const underpaymentPolicy of ["wallet", "suspense"] as const) {
      expect(decidePaymentIntake(input({ currency: "USD", underpaymentPolicy }))).toEqual({
        outcome: "suspense",
        reason: "currency_mismatch",
      });
    }
  });

  it("puts a shortfall in the wallet and reports the exact shortfall", () => {
    expect(decidePaymentIntake(input({ amountMinor: 12_500n }))).toEqual({
      outcome: "credited",
      creditedMinor: 12_500n,
      shortfallMinor: 7_500n,
      reason: "underpayment",
    });
  });

  it("suspends a shortfall for tenants that review every short payment", () => {
    expect(
      decidePaymentIntake(input({ amountMinor: 12_500n, underpaymentPolicy: "suspense" })),
    ).toEqual({ outcome: "suspense", reason: "underpayment" });
  });

  it("credits, rather than refuses, money arriving for a day that is already paid", () => {
    expect(decidePaymentIntake(input({ dayAlreadySettled: true }))).toEqual({
      outcome: "credited",
      creditedMinor: 20_000n,
      shortfallMinor: 0n,
      reason: "already_settled",
    });
  });

  it("credits money when the wallet already covers the day", () => {
    expect(decidePaymentIntake(input({ requiredMinor: 0n }))).toEqual({
      outcome: "credited",
      creditedMinor: 20_000n,
      shortfallMinor: 0n,
      reason: "nothing_required",
    });
  });

  it("credits rather than suspending when the day needs nothing but the wallet is short of the fee", () => {
    // `requiredMinor` is zero because existing credit covers the fee; an arriving
    // payment is surplus, not a shortfall, even under the suspense policy.
    expect(
      decidePaymentIntake(input({ requiredMinor: 0n, underpaymentPolicy: "suspense" })),
    ).toEqual({
      outcome: "credited",
      creditedMinor: 20_000n,
      shortfallMinor: 0n,
      reason: "nothing_required",
    });
  });

  it("refuses to guess what a negative requirement means", () => {
    expect(() => decidePaymentIntake(input({ requiredMinor: -1n }))).toThrow(RangeError);
  });
});
