import type { TenantConfig } from "@tpirs/config";

/**
 * Pure helpers behind the collector cash screen.
 *
 * Kept out of the page component so the interesting rules — which fee rule
 * pre-fills the amount, what counts as overdue, how a client reference is
 * minted — are unit-testable without rendering, and so the page itself stays a
 * thin arrangement of queries and forms.
 */

/** One wallet as `GET /v1/cash/wallets` returns it (money as strings). */
export interface CashWalletView {
  readonly collectorUserId: string;
  readonly status: "active" | "frozen";
  readonly frozenAt: string | null;
  readonly frozenReason: string | null;
  readonly overdueSince: string | null;
  readonly floatCeilingMinor: string | null;
  readonly balanceMinor: string;
  readonly openIntakeTotalMinor: string;
  readonly oldestOpenIntakeAt: string | null;
  readonly lastDepositAt: string | null;
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

/**
 * The amount the form pre-fills: the newest effective rule for the asset type.
 *
 * This is a convenience only. The fee engine decides what the day costs and the
 * API refuses an intake that does not match exactly (`amount_mismatch`), so a
 * stale pre-fill surfaces as a clear error instead of taking the wrong cash.
 */
export function prefillAmountMinor(
  config: TenantConfig,
  assetTypeKey: string,
  today: string,
): string | undefined {
  const rules = config.obligations.feeRules
    .filter((rule) => rule.assetTypeKey === assetTypeKey && rule.effectiveFrom <= today)
    .sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
  return rules[0] === undefined ? undefined : String(rules[0].amountMinor);
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
  return wallet.overdueSince === null ? "Active" : "Active (overdue)";
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
