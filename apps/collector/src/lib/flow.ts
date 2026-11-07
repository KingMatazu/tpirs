/**
 * The collector flow's decisions, kept out of the components so they can be
 * tested without a browser: can this collector take cash right now, and why not.
 * The server enforces every rule again — this is what the phone shows.
 */

export interface WalletView {
  readonly collectorUserId: string;
  readonly status: "active" | "frozen";
  readonly frozenReason: string | null;
  readonly floatCeilingMinor: string | null;
  /** Signed position: positive is cash in hand, negative is prepaid credit. */
  readonly balanceMinor: string;
  /** How much more cash may be taken now; the server checks the same number. */
  readonly availableMinor?: string;
  /** `max(0, intakeLimit - balance)`, for the fallback when the field is absent. */
  readonly intakeLimitMinor?: string;
  readonly model?: "postpaid" | "prepaid";
  readonly maxBalanceMinor?: string | null;
  readonly openIntakeTotalMinor: string;
  readonly oldestOpenIntakeAt: string | null;
  readonly lastDepositAt: string | null;
  readonly depositInstruction: {
    readonly provider: string;
    readonly reference: string;
    readonly kind: "virtual_account" | "narration" | "virtual_terminal";
    readonly accountNumber?: string | null;
    readonly accountName?: string | null;
    readonly bank?: string | null;
    readonly pageUrl?: string | null;
    readonly currency?: string | null;
  } | null;
}

export type BlockedReason =
  "frozen" | "already_paid" | "no_fee" | "float_low" | "offline" | "unknown_asset";

export interface CollectDecision {
  readonly allowed: boolean;
  readonly reason?: BlockedReason;
  /** The signed position (cash in hand, or credit when negative). */
  readonly floatLeftMinor: bigint;
  /** How much more cash may be taken; the number `float_low` is about. */
  readonly availableMinor: bigint;
}

export function toBigInt(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Cash still in hand: the derived balance (positive when the collector owes cash). */
export function floatLeftMinor(wallet: WalletView | undefined): bigint {
  return wallet === undefined ? 0n : toBigInt(wallet.balanceMinor);
}

/**
 * How much more cash the collector may take.
 *
 * The API sends `availableMinor` (the configured limit minus the position); an
 * older payload without it falls back to the balance, which is the pre-ADR-0069
 * behaviour. Prepaid settles this at zero until the wallet is funded.
 */
export function availableMinorOf(wallet: WalletView | undefined): bigint {
  if (wallet === undefined) return 0n;
  if (wallet.availableMinor !== undefined) return toBigInt(wallet.availableMinor);
  return floatLeftMinor(wallet);
}

/**
 * The order matters: a frozen wallet blocks before anything else, then an
 * already-paid asset, then a day the tenant has not priced, then a wallet that
 * cannot cover another fee, then the network. The first true reason is the one
 * the phone explains.
 *
 * The fee is the tenant's, never the collector's: a zero fee means the fee
 * engine found no rule for this vehicle today, and collecting nothing is not a
 * payment. The amount is not an input the phone can change.
 */
export function decideCollect(input: {
  readonly wallet: WalletView | undefined;
  readonly paymentStatus: "paid" | "no_payment_recorded" | "unknown";
  readonly feeMinor: bigint;
  readonly online: boolean;
}): CollectDecision {
  const left = floatLeftMinor(input.wallet);
  const available = availableMinorOf(input.wallet);

  if (input.wallet?.status === "frozen") {
    return { allowed: false, reason: "frozen", floatLeftMinor: left, availableMinor: available };
  }
  if (input.paymentStatus === "paid") {
    return {
      allowed: false,
      reason: "already_paid",
      floatLeftMinor: left,
      availableMinor: available,
    };
  }
  if (input.feeMinor <= 0n) {
    return { allowed: false, reason: "no_fee", floatLeftMinor: left, availableMinor: available };
  }
  if (available < input.feeMinor) {
    return { allowed: false, reason: "float_low", floatLeftMinor: left, availableMinor: available };
  }
  if (!input.online) {
    return { allowed: false, reason: "offline", floatLeftMinor: left, availableMinor: available };
  }
  return { allowed: true, floatLeftMinor: left, availableMinor: available };
}

/**
 * How full the wallet's usable float is, for the home screen bar (0–100).
 *
 * Prepaid measures the credit left against the configured maximum, so the bar
 * empties as the collector works and refills on a top-up. Postpaid measures the
 * cash in hand against the ceiling, which is the exposure it caps.
 */
export function floatPercent(wallet: WalletView | undefined): number {
  if (wallet === undefined) return 0;
  if (wallet.model === "prepaid") {
    const max = toBigInt(wallet.maxBalanceMinor ?? null);
    if (max === 0n) return 0;
    const percent = Number((availableMinorOf(wallet) * 100n) / max);
    return Math.max(0, Math.min(100, percent));
  }
  if (wallet.floatCeilingMinor === null) return 0;
  const ceiling = toBigInt(wallet.floatCeilingMinor);
  if (ceiling === 0n) return 0;
  const percent = Number((toBigInt(wallet.balanceMinor) * 100n) / ceiling);
  return Math.max(0, Math.min(100, percent));
}
