import { DomainError } from "./errors.js";
import type { LedgerPosting } from "./ledger.js";
import type { Money } from "./money.js";

/**
 * Collector cash domain rules.
 *
 * The collector's balance is not stored anywhere (ADR 0031): it is derived
 * from `COLLECTOR_CASH` ledger entries. Everything here therefore works on
 * amounts passed in by the caller, and the only stateful concept is the wallet
 * row's status. All amounts are integer minor units in one currency; the
 * currency check happens at the posting, not here.
 */

/** Lifecycle status of a collector wallet row. */
export type CashWalletStatus = "active" | "frozen";

/** Immutable wallet state used by the transition functions. */
export interface CashWalletState {
  readonly status: CashWalletStatus;
  /** Set when frozen; required by policy to have a reason (ADR 0033). */
  readonly frozenReason: string | null;
}

export type CashWalletTransition = "freeze" | "unfreeze";

export type CashErrorCode =
  | "cash_disabled"
  | "wallet_frozen"
  | "ceiling_exceeded"
  | "already_paid"
  | "amount_mismatch"
  | "duplicate_reference"
  | "invalid_amount";

export class CashError extends DomainError {
  readonly code: CashErrorCode;

  constructor(code: CashErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Freezes or unfreezes a wallet as a pure state function.
 *
 * Both directions are idempotent: freezing an already-frozen wallet and
 * unfreezing an active one return the state unchanged, so an API client's
 * double click does not produce an error where nothing is wrong. The reason is
 * carried on the returned state, not written here; the caller is responsible
 * for the audit entry (ADR 0033).
 */
export function transitionWallet(
  current: CashWalletState,
  transition: CashWalletTransition,
  reason: string | null,
): CashWalletState {
  if (transition === "freeze") {
    if (current.status === "frozen") {
      return current;
    }
    return { status: "frozen", frozenReason: reason ?? "unspecified" };
  }
  if (current.status === "active") {
    return current;
  }
  return { status: "active", frozenReason: null };
}

/** Whether the wallet accepts a new cash intake. */
export function canIntake(status: CashWalletStatus): boolean {
  return status === "active";
}

export interface CeilingInput {
  /** Derived `COLLECTOR_CASH` balance already held, minor units. */
  readonly balanceMinor: number;
  /** The intake being attempted, minor units; must be positive. */
  readonly intakeMinor: number;
  /** Configured ceiling for undeposited cash, minor units; must be positive. */
  readonly ceilingMinor: number;
}

/**
 * Asserts that a cash intake would keep the undeposited float at or below the
 * ceiling. Inclusive at the boundary: a float that exactly equals the ceiling
 * is legal, one more unit is not.
 *
 * The database cannot express this, because the balance is derived from an
 * append-only ledger. The caller serialises intakes for one collector with a
 * wallet row lock, which is what makes the check sound (ADR 0031, 0033).
 */
export function assertWithinCeiling(input: CeilingInput): void {
  const { balanceMinor, intakeMinor, ceilingMinor } = input;
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0) {
    throw new CashError("invalid_amount", `Balance ${balanceMinor} is not a non-negative integer`);
  }
  if (!Number.isSafeInteger(intakeMinor) || intakeMinor <= 0) {
    throw new CashError("invalid_amount", `Intake ${intakeMinor} must be a positive integer`);
  }
  if (!Number.isSafeInteger(ceilingMinor) || ceilingMinor <= 0) {
    throw new CashError("invalid_amount", `Ceiling ${ceilingMinor} must be a positive integer`);
  }
  if (balanceMinor + intakeMinor > ceilingMinor) {
    throw new CashError(
      "ceiling_exceeded",
      `Float ceiling exceeded: holding ${balanceMinor}, intake ${intakeMinor}, ceiling ${ceilingMinor}`,
    );
  }
}

export type DepositClassification = "matched" | "partial" | "surplus";

export interface DepositInput {
  /** The deposit that arrived, minor units; must be positive. */
  readonly depositMinor: number;
  /** Sum of the collector's still-open cash intakes, minor units. */
  readonly openIntakeTotalMinor: number;
}

/**
 * Classifies a deposit against the open intakes it is meant to clear.
 *
 * - `matched`: the deposit exactly clears every open intake.
 * - `partial`: the deposit is smaller than the open total; the rest stays open.
 * - `surplus`: the deposit exceeds the open total (or there is nothing open).
 *   The surplus stays in suspense and is never auto-credited (D35, ADR 0032).
 */
export function classifyDeposit(input: DepositInput): DepositClassification {
  const { depositMinor, openIntakeTotalMinor } = input;
  if (!Number.isSafeInteger(depositMinor) || depositMinor <= 0) {
    throw new CashError("invalid_amount", `Deposit ${depositMinor} must be a positive integer`);
  }
  if (!Number.isSafeInteger(openIntakeTotalMinor) || openIntakeTotalMinor < 0) {
    throw new CashError(
      "invalid_amount",
      `Open intake total ${openIntakeTotalMinor} is not a non-negative integer`,
    );
  }
  if (depositMinor < openIntakeTotalMinor) {
    return "partial";
  }
  if (depositMinor === openIntakeTotalMinor) {
    return "matched";
  }
  return "surplus";
}

export interface DepositAgeInput {
  /** When the cash was taken (an instant). */
  readonly recordedAt: Date;
  /** The moment to measure against, usually the sweep time. */
  readonly now: Date;
}

/**
 * Hours the cash has been held, as elapsed wall time between two instants.
 *
 * The deadline is an hours-from-intake rule, not a calendar-day rule (ADR
 * 0033), so the only computation is a subtraction of instants: a collector who
 * takes cash at 16:00 and deposits at 15:00 the next day held it for 23 hours,
 * regardless of how the local clock is labelled.
 */
export function depositAgeHours(input: DepositAgeInput): number {
  const { recordedAt, now } = input;
  const elapsedMs = now.getTime() - recordedAt.getTime();
  return elapsedMs / 3_600_000;
}

export interface OverdueInput extends DepositAgeInput {
  readonly depositDeadlineHours: number;
}

/**
 * True when an open intake is at least `depositDeadlineHours` old. Exactly at
 * the deadline the cash is due; the sweeper therefore flags at the boundary.
 */
export function isDepositOverdue(input: OverdueInput): boolean {
  const { depositDeadlineHours } = input;
  if (!Number.isSafeInteger(depositDeadlineHours) || depositDeadlineHours <= 0) {
    throw new CashError(
      "invalid_amount",
      `Deposit deadline ${depositDeadlineHours} must be a positive integer of hours`,
    );
  }
  return depositAgeHours(input) >= depositDeadlineHours;
}

/**
 * The collector attribution carried on cash ledger postings. Cash entries must
 * be attributable per collector because balances are derived from them; the
 * optional field on `LedgerPosting` is how that attribution travels.
 */
export const COLLECTOR_CASH_ACCOUNT = "COLLECTOR_CASH";

export interface CashPostingOptions {
  readonly collectorUserId?: string;
}

/**
 * Builds the funding leg pair for a cash intake settlement: debit the
 * collector cash account, credit the asset wallet. Balanced by construction.
 * The allocation engine posts the wallet-to-revenue legs separately, exactly
 * as it does for gateway money.
 */
export function cashFundingPostings(
  amount: Money,
  options: CashPostingOptions = {},
): readonly LedgerPosting[] {
  return [
    {
      accountCode: COLLECTOR_CASH_ACCOUNT,
      direction: "debit",
      amount,
      ...(options.collectorUserId === undefined
        ? {}
        : { collectorUserId: options.collectorUserId }),
    },
    { accountCode: "ASSET_WALLET", direction: "credit", amount },
  ];
}
