import type { Money } from "./money.js";

export type AccountClass = "asset" | "liability" | "revenue";
export type AccountType =
  | "asset_wallet"
  | "revenue_levy"
  | "gateway_clearing"
  | "settlement_bank"
  | "suspense"
  | "collector_cash";
export type LedgerDirection = "debit" | "credit";
export type ObligationStatus = "unpaid" | "paid" | "waived";
export type ReversalStatus = "pending" | "approved" | "rejected";

export interface LedgerPosting {
  readonly accountCode: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly assetId?: string;
  readonly paymentId?: string;
  readonly obligationPeriodId?: string;
  readonly memo?: string;
}

export interface BalancedTransaction {
  readonly postings: readonly LedgerPosting[];
}

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

/**
 * Validates that a transaction is balanced (sum of debits equals sum of credits)
 * and that all postings use the same currency.
 */
export function validateBalancedTransaction(postings: readonly LedgerPosting[]): void {
  if (postings.length < 2) {
    throw new LedgerInvariantError("A transaction must have at least two postings");
  }

  const firstPosting = postings[0];
  if (!firstPosting) {
    throw new LedgerInvariantError("A transaction must have at least two postings");
  }
  const currency = firstPosting.amount.currency;
  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const posting of postings) {
    if (posting.amount.currency !== currency) {
      throw new LedgerInvariantError("All postings in a transaction must use the same currency");
    }
    if (posting.amount.amount <= 0) {
      throw new LedgerInvariantError("Posting amounts must be positive");
    }
    if (posting.direction === "debit") {
      debitTotal += BigInt(posting.amount.amount);
    } else {
      creditTotal += BigInt(posting.amount.amount);
    }
  }

  if (debitTotal !== creditTotal) {
    throw new LedgerInvariantError(
      `Transaction is not balanced: debits=${debitTotal.toString()} credits=${creditTotal.toString()}`,
    );
  }
}

export const STANDARD_ACCOUNTS: readonly {
  readonly code: string;
  readonly accountType: AccountType;
  readonly accountClass: AccountClass;
}[] = [
  { code: "ASSET_WALLET", accountType: "asset_wallet", accountClass: "liability" },
  { code: "REVENUE_LEVY", accountType: "revenue_levy", accountClass: "revenue" },
  { code: "GATEWAY_CLEARING", accountType: "gateway_clearing", accountClass: "asset" },
  { code: "SETTLEMENT_BANK", accountType: "settlement_bank", accountClass: "asset" },
  { code: "SUSPENSE", accountType: "suspense", accountClass: "liability" },
  { code: "COLLECTOR_CASH", accountType: "collector_cash", accountClass: "asset" },
];
