/**
 * Pure helpers behind the collector cash screen.
 *
 * Kept out of the page component so the interesting rules — what counts as
 * overdue, how a client reference is minted, which deposits can match which
 * intakes — are unit-testable without rendering, and so the page itself stays a
 * thin arrangement of queries and forms.
 */

/** The collector's funding destination, when finance provisioned one. */
export interface DepositInstructionView {
  readonly provider: string;
  readonly reference: string;
  readonly kind: "virtual_account" | "narration" | "virtual_terminal";
  readonly accountNumber?: string | null;
  readonly accountName?: string | null;
  readonly bank?: string | null;
  readonly pageUrl?: string | null;
  readonly currency?: string | null;
}

/** One wallet as `GET /v1/cash/wallets` returns it (money as strings). */
export interface CashWalletView {
  readonly collectorUserId: string;
  readonly status: "active" | "frozen";
  readonly frozenAt: string | null;
  readonly frozenReason: string | null;
  readonly overdueSince: string | null;
  readonly floatCeilingMinor: string | null;
  readonly balanceMinor: string;
  /** Present on every response since ADR 0069; optional keeps old fixtures valid. */
  readonly model?: "postpaid" | "prepaid";
  readonly availableMinor?: string;
  readonly intakeLimitMinor?: string;
  readonly maxBalanceMinor?: string | null;
  readonly openIntakeTotalMinor: string;
  readonly oldestOpenIntakeAt: string | null;
  readonly lastDepositAt: string | null;
  readonly depositInstruction?: DepositInstructionView | null;
}

/** One intake as the wallet detail returns it. */
export interface CashIntakeView {
  readonly id: string;
  readonly collectorUserId: string;
  readonly assetId: string;
  readonly zoneId: string | null;
  readonly businessDate: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: "open" | "matched" | "reversed";
  readonly receiptNumber: string;
  readonly recordedAt: string;
}

/** One deposit as `GET /v1/cash/deposits` returns it. */
export interface CashDepositView {
  readonly id: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly collectorUserId: string | null;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: "matched" | "partial" | "suspense";
  readonly createdAt: string;
}

/** The asset fields the take-cash form needs from `GET /v1/assets`. */
export interface AssetLookupRow {
  readonly id: string;
  readonly assetTypeKey: string;
  readonly shortCode: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** The driver-facing name of an asset, from its own attributes (D7). */
export function assetLabel(asset: AssetLookupRow): string {
  const plate = asset.attributes["plate_number"] ?? asset.attributes["plateNumber"];
  return typeof plate === "string" && plate.trim() !== "" ? plate : asset.shortCode;
}

/** A client reference minted in the browser: the intake's idempotency key. */
export function newClientReference(collectorUserId: string): string {
  const random =
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
  return `cash-${collectorUserId}-${random}`;
}

/**
 * Whether the collector is past the deposit deadline.
 *
 * The server owns the real decision (the sweeper sets `overdueSince`); the
 * screen derives the same answer from the oldest open intake so a supervisor
 * sees the clock ticking before the next sweep runs.
 */
export function isOverdue(wallet: CashWalletView, deadlineHours: number, now: Date): boolean {
  // Prepaid collectors owe nothing: the wallet is funded before the cash is
  // taken, so there is no deposit deadline to be late for (ADR 0069).
  if (wallet.model === "prepaid") return false;
  if (wallet.overdueSince !== null) return true;
  if (wallet.oldestOpenIntakeAt === null) return false;
  const age = now.getTime() - new Date(wallet.oldestOpenIntakeAt).getTime();
  return age > deadlineHours * 3_600_000;
}

/** Whole hours an intake has been open, floored, for the "held for" column. */
export function heldHours(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 3_600_000));
}

/**
 * The pairing candidates for a manual match: suspense deposits on one side,
 * open intakes on the other. A `suspense` deposit posted nothing yet, so it is
 * the only deposit state that needs a human (D35).
 */
export function matchCandidates(
  deposits: readonly CashDepositView[],
  intakes: readonly CashIntakeView[],
): {
  readonly suspense: readonly CashDepositView[];
  readonly open: readonly CashIntakeView[];
} {
  return {
    suspense: deposits.filter((deposit) => deposit.status === "suspense"),
    open: intakes.filter((intake) => intake.status === "open"),
  };
}

/** Human label for a wallet state; the API keeps the enum, the UI explains it. */
export function walletStatusLabel(wallet: CashWalletView): string {
  if (wallet.status === "frozen") return "Frozen";
  if (wallet.model === "prepaid" && toMinor(wallet.availableMinor) <= 0n) return "No float";
  return wallet.overdueSince === null ? "Active" : "Active (overdue)";
}

function toMinor(value: string | undefined): bigint {
  if (value === undefined || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** The number the screen calls "float available", for either model. */
export function availableMinorOf(wallet: CashWalletView): string {
  if (wallet.model === "prepaid") return wallet.availableMinor ?? "0";
  return wallet.availableMinor ?? wallet.balanceMinor;
}

/**
 * Prepaid credit as a positive amount: the signed balance is negative while the
 * platform holds the collector's money, and finance reads that as a credit.
 */
export function creditMinorOf(wallet: CashWalletView): string {
  const balance = toMinor(wallet.balanceMinor);
  return (balance < 0n ? -balance : 0n).toString();
}

/** Human label for a deposit state. */
export function depositStatusLabel(status: CashDepositView["status"]): string {
  switch (status) {
    case "matched":
      return "Matched";
    case "partial":
      return "Partly matched";
    case "suspense":
      return "In suspense";
  }
}
