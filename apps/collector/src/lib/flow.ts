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
  readonly balanceMinor: string;
  readonly openIntakeTotalMinor: string;
  readonly oldestOpenIntakeAt: string | null;
  readonly lastDepositAt: string | null;
  readonly depositInstruction: {
    readonly provider: string;
    readonly reference: string;
    readonly kind: "virtual_account" | "narration";
  } | null;
}

export type BlockedReason = "frozen" | "already_paid" | "float_low" | "offline" | "unknown_asset";

export interface CollectDecision {
  readonly allowed: boolean;
  readonly reason?: BlockedReason;
  /** The cash the collector still holds, minor units. */
  readonly floatLeftMinor: bigint;
}

export function toBigInt(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Cash still in hand: the derived balance, capped by the ceiling for display. */
export function floatLeftMinor(wallet: WalletView | undefined): bigint {
  return wallet === undefined ? 0n : toBigInt(wallet.balanceMinor);
}

/**
 * The order matters: a frozen wallet blocks before anything else, then an
 * already-paid asset, then a wallet that cannot cover another fee, then the
 * network. The first true reason is the one the phone explains.
 */
export function decideCollect(input: {
  readonly wallet: WalletView | undefined;
  readonly paymentStatus: "paid" | "no_payment_recorded" | "unknown";
  readonly feeMinor: bigint;
  readonly online: boolean;
}): CollectDecision {
  const left = floatLeftMinor(input.wallet);

  if (input.wallet?.status === "frozen") {
    return { allowed: false, reason: "frozen", floatLeftMinor: left };
  }
  if (input.paymentStatus === "paid") {
    return { allowed: false, reason: "already_paid", floatLeftMinor: left };
  }
  if (input.feeMinor > 0n && left < input.feeMinor) {
    return { allowed: false, reason: "float_low", floatLeftMinor: left };
  }
  if (!input.online) {
    return { allowed: false, reason: "offline", floatLeftMinor: left };
  }
  return { allowed: true, floatLeftMinor: left };
}

/** How full the float is, for the progress bar on the home screen (0–100). */
export function floatPercent(wallet: WalletView | undefined): number {
  if (wallet?.floatCeilingMinor === null || wallet === undefined) return 0;
  const ceiling = toBigInt(wallet.floatCeilingMinor);
  if (ceiling === 0n) return 0;
  const percent = Number((toBigInt(wallet.balanceMinor) * 100n) / ceiling);
  return Math.max(0, Math.min(100, percent));
}
