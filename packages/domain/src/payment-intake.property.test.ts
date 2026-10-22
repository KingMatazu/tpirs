import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decidePaymentIntake } from "./payment-intake.js";
import type { PaymentIntakeInput, UnderpaymentPolicy } from "./payment-intake.js";
import { checkProperty } from "./test-support/property.js";

const policyArb = fc.constantFrom<UnderpaymentPolicy>("wallet", "suspense");
const amountArb = fc.bigInt({ min: 1n, max: 1_000_000_000n });
const requiredArb = fc.bigInt({ min: 0n, max: 1_000_000_000n });
const currencyArb = fc.constantFrom("NGN", "GHS", "KES");

const inputArb: fc.Arbitrary<PaymentIntakeInput> = fc.record({
  amountMinor: amountArb,
  currency: currencyArb,
  requiredMinor: requiredArb,
  requiredCurrency: currencyArb,
  underpaymentPolicy: policyArb,
  alreadyRecorded: fc.boolean(),
  attributable: fc.boolean(),
  dayAlreadySettled: fc.boolean(),
});

describe("payment intake properties", () => {
  it("never loses or invents money", () => {
    checkProperty(
      "intake conserves the received amount",
      fc.property(inputArb, (input) => {
        const decision = decidePaymentIntake(input);
        switch (decision.outcome) {
          case "duplicate":
          case "rejected":
          case "suspense":
            break;
          case "credited":
            expect(decision.creditedMinor).toBe(input.amountMinor);
            expect(decision.shortfallMinor >= 0n).toBe(true);
            expect(decision.creditedMinor > 0n).toBe(true);
            break;
          case "applied":
            expect(decision.appliedMinor > 0n).toBe(true);
            expect(decision.surplusMinor >= 0n).toBe(true);
            expect(decision.appliedMinor + decision.surplusMinor).toBe(input.amountMinor);
            break;
        }
      }),
    );
  });

  it("only applies a payment that can actually settle the day", () => {
    checkProperty(
      "applied implies an eligible payment",
      fc.property(inputArb, (input) => {
        const decision = decidePaymentIntake(input);
        if (decision.outcome !== "applied") return;
        expect(input.alreadyRecorded).toBe(false);
        expect(input.attributable).toBe(true);
        expect(input.currency).toBe(input.requiredCurrency);
        expect(input.dayAlreadySettled).toBe(false);
        expect(input.requiredMinor > 0n).toBe(true);
        expect(input.amountMinor >= input.requiredMinor).toBe(true);
      }),
    );
  });

  it("treats every replay as a no-op", () => {
    checkProperty(
      "a recorded event is always a duplicate",
      fc.property(inputArb, (input) => {
        expect(decidePaymentIntake({ ...input, alreadyRecorded: true })).toEqual({
          outcome: "duplicate",
        });
      }),
    );
  });

  it("states the exact shortfall and keeps the whole amount when policy is wallet", () => {
    checkProperty(
      "wallet policy credits a shortfall exactly",
      fc.property(amountArb, requiredArb, (amountMinor, requiredMinor) => {
        if (amountMinor >= requiredMinor || requiredMinor === 0n) return;
        const decision = decidePaymentIntake({
          amountMinor,
          currency: "NGN",
          requiredMinor,
          requiredCurrency: "NGN",
          underpaymentPolicy: "wallet",
          alreadyRecorded: false,
          attributable: true,
          dayAlreadySettled: false,
        });
        expect(decision).toEqual({
          outcome: "credited",
          creditedMinor: amountMinor,
          shortfallMinor: requiredMinor - amountMinor,
          reason: "underpayment",
        });
      }),
    );
  });

  it("suspends a shortfall only when the tenant asks for review", () => {
    checkProperty(
      "policy only changes short payments",
      fc.property(amountArb, requiredArb, policyArb, (amountMinor, requiredMinor, policy) => {
        if (amountMinor >= requiredMinor || requiredMinor === 0n) return;
        const decision = decidePaymentIntake({
          amountMinor,
          currency: "NGN",
          requiredMinor,
          requiredCurrency: "NGN",
          underpaymentPolicy: policy,
          alreadyRecorded: false,
          attributable: true,
          dayAlreadySettled: false,
        });
        if (policy === "suspense") {
          expect(decision).toEqual({ outcome: "suspense", reason: "underpayment" });
        } else {
          expect(decision.outcome).toBe("credited");
        }
      }),
    );
  });

  it("ignores the underpayment policy once the payment covers the day", () => {
    checkProperty(
      "policy is irrelevant to sufficient payments",
      fc.property(amountArb, requiredArb, (amountMinor, requiredMinor) => {
        if (requiredMinor === 0n || amountMinor < requiredMinor) return;
        const base = {
          amountMinor,
          currency: "NGN",
          requiredMinor,
          requiredCurrency: "NGN",
          alreadyRecorded: false,
          attributable: true,
          dayAlreadySettled: false,
        } as const;
        expect(decidePaymentIntake({ ...base, underpaymentPolicy: "wallet" })).toEqual(
          decidePaymentIntake({ ...base, underpaymentPolicy: "suspense" }),
        );
      }),
    );
  });

  it("always suspends a currency mismatch on an attributable payment", () => {
    checkProperty(
      "currency mismatch is always suspense",
      fc.property(
        amountArb,
        requiredArb,
        currencyArb,
        currencyArb,
        (amountMinor, requiredMinor, currency, requiredCurrency) => {
          if (currency === requiredCurrency) return;
          const decision = decidePaymentIntake({
            amountMinor,
            currency,
            requiredMinor,
            requiredCurrency,
            underpaymentPolicy: "wallet",
            alreadyRecorded: false,
            attributable: true,
            dayAlreadySettled: false,
          });
          expect(decision).toEqual({ outcome: "suspense", reason: "currency_mismatch" });
        },
      ),
    );
  });

  it("is deterministic", () => {
    checkProperty(
      "same input, same decision",
      fc.property(inputArb, (input) => {
        expect(decidePaymentIntake(input)).toEqual(decidePaymentIntake(input));
      }),
    );
  });
});
