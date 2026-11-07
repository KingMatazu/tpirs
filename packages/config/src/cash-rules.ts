import type { CashFundingRail, CashIntakeGuard, CashModel, TenantCashRules } from "./schema.js";

/**
 * The cash-rule defaults, in one place.
 *
 * Every accessor answers "what does this tenant mean" without the caller having
 * to know whether the field was written by a newer config or is absent from one
 * that predates it. A missing field is the documented default, never a reason to
 * branch on a tenant's identity (ADR 0069).
 */

/** ₦50,000 in minor units. */
export const DEFAULT_MAX_BALANCE_MINOR = 5_000_000;

export function cashModelOf(rules: TenantCashRules): CashModel {
  return rules.model ?? "postpaid";
}

export function intakeGuardOf(rules: TenantCashRules): CashIntakeGuard {
  return rules.intakeGuard ?? "hard";
}

export function maxBalanceMinorOf(rules: TenantCashRules): number {
  return rules.maxBalanceMinor ?? DEFAULT_MAX_BALANCE_MINOR;
}

/** The amount an intake may cross zero by. Zero under a hard guard. */
export function graceMinorOf(rules: TenantCashRules): number {
  return intakeGuardOf(rules) === "grace" ? (rules.graceMinor ?? 0) : 0;
}

/**
 * The signed position an intake may reach: the postpaid ceiling, or the prepaid
 * grace. The domain compares `balance + amount` against this number.
 */
export function intakeLimitMinorOf(rules: TenantCashRules): number {
  return cashModelOf(rules) === "prepaid" ? graceMinorOf(rules) : rules.floatCeilingMinor;
}

export function fundingRailOf(rules: TenantCashRules): CashFundingRail {
  return rules.funding ?? "virtual_terminal";
}
