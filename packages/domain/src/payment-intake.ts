/**
 * The intake decision: what to do with money that just arrived.
 *
 * This is the pure half of the payment pipeline. The application layer resolves
 * the provider reference to an asset, prices the day, posts ledger entries, and
 * writes rows; this function only decides which of those postings is allowed.
 * Keeping the decision pure means the awkward cases - a replay, a short
 * payment, an overpayment, a second payment for a day that is already paid -
 * are testable without a database or a gateway.
 *
 * The shape follows ADR 0019 (underpayment policy) and ADR 0016 (replay
 * handling):
 *
 * | Situation                              | Outcome                    |
 * | -------------------------------------- | -------------------------- |
 * | provider event already processed       | `duplicate` (do nothing)   |
 * | amount not positive                    | `rejected`                 |
 * | reference resolved to no asset         | `suspense` (unattributable)|
 * | received currency differs from the fee | `suspense` (currency)      |
 * | the day is already settled             | `credited` (wallet)        |
 * | nothing left to ask for                | `credited` (wallet)        |
 * | amount below the required amount       | `credited` or `suspense`   |
 * | amount covers the required amount      | `applied` (day settles)    |
 *
 * `requiredMinor` is what the payer was asked to send: the day's fee less any
 * wallet balance the asset already holds, floored at zero. It is not always the
 * fee, and it is never zero for an intent that was actually issued. The
 * application computes it when it creates the intent (and again at intake for a
 * payment that had no intent).
 */

/** Tenant setting for a shortfall: keep the money as credit, or freeze it for finance. */
export type UnderpaymentPolicy = "wallet" | "suspense";

export interface PaymentIntakeInput {
  /** Amount actually received, in minor units. */
  readonly amountMinor: bigint;
  /** Currency actually received, uppercase ISO 4217. */
  readonly currency: string;
  /** `fee - wallet balance` at the time the payer was quoted, floored at zero. */
  readonly requiredMinor: bigint;
  /** Currency the day is priced in. */
  readonly requiredCurrency: string;
  readonly underpaymentPolicy: UnderpaymentPolicy;
  /** A payment row for this provider event already exists. */
  readonly alreadyRecorded: boolean;
  /** The provider reference resolved to an asset and an instruction. */
  readonly attributable: boolean;
  /** The business day already has a settled (paid) period. */
  readonly dayAlreadySettled: boolean;
}

export type PaymentIntakeSuspenseReason = "unattributable" | "currency_mismatch" | "underpayment";

export type PaymentIntakeCreditReason = "underpayment" | "already_settled" | "nothing_required";

export type PaymentIntakeDecision =
  /** The same provider event was already processed; no row, posting, or SMS. */
  | { readonly outcome: "duplicate" }
  /** Structurally impossible money; store the event but create no payment. */
  | { readonly outcome: "rejected"; readonly reason: "non_positive_amount" }
  /** Money is real but cannot be assigned to a day; finance must resolve it. */
  | { readonly outcome: "suspense"; readonly reason: PaymentIntakeSuspenseReason }
  /** Money credits the asset wallet and settles no day. */
  | {
      readonly outcome: "credited";
      /** Always the received amount: every kobo reaches the wallet. */
      readonly creditedMinor: bigint;
      /** What the payer still has to send for this day to settle; zero when none. */
      readonly shortfallMinor: bigint;
      readonly reason: PaymentIntakeCreditReason;
    }
  /** Money settles the current business day and the remainder stays as wallet credit. */
  | {
      readonly outcome: "applied";
      /** The part of this payment that settles the day (`requiredMinor`). */
      readonly appliedMinor: bigint;
      /** What stays in the wallet afterwards (`amountMinor - requiredMinor`). */
      readonly surplusMinor: bigint;
    };

/**
 * Decides what a received payment may do.
 *
 * The order of the checks is part of the contract:
 *
 * 1. A replay is a no-op before anything else, so a retry can never be
 *    reclassified by a later config change.
 * 2. A non-positive amount is rejected before it can reach a ledger.
 * 3. Unattributable money and a currency mismatch always go to suspense,
 *    whatever the tenant's underpayment policy says (D19).
 * 4. A day with nothing left to pay, or a day that is already settled, can only
 *    receive wallet credit; money is never refused merely because the day needs
 *    none.
 * 5. A shortfall follows the tenant policy: wallet credit (default) or suspense.
 * 6. Anything else settles the day. The allocation engine decides how much of
 *    the wallet - this payment plus prior credit - the fee actually takes.
 */
export function decidePaymentIntake(input: PaymentIntakeInput): PaymentIntakeDecision {
  if (input.requiredMinor < 0n) {
    throw new RangeError("requiredMinor must not be negative");
  }

  if (input.alreadyRecorded) {
    return { outcome: "duplicate" };
  }
  if (input.amountMinor <= 0n) {
    return { outcome: "rejected", reason: "non_positive_amount" };
  }
  if (!input.attributable) {
    return { outcome: "suspense", reason: "unattributable" };
  }
  if (input.currency !== input.requiredCurrency) {
    return { outcome: "suspense", reason: "currency_mismatch" };
  }

  if (input.requiredMinor === 0n) {
    return {
      outcome: "credited",
      creditedMinor: input.amountMinor,
      shortfallMinor: 0n,
      reason: "nothing_required",
    };
  }

  if (input.dayAlreadySettled) {
    return {
      outcome: "credited",
      creditedMinor: input.amountMinor,
      shortfallMinor: 0n,
      reason: "already_settled",
    };
  }

  if (input.amountMinor < input.requiredMinor) {
    if (input.underpaymentPolicy === "suspense") {
      return { outcome: "suspense", reason: "underpayment" };
    }
    return {
      outcome: "credited",
      creditedMinor: input.amountMinor,
      shortfallMinor: input.requiredMinor - input.amountMinor,
      reason: "underpayment",
    };
  }

  return {
    outcome: "applied",
    appliedMinor: input.requiredMinor,
    surplusMinor: input.amountMinor - input.requiredMinor,
  };
}
