import type { BusinessDate } from "./business-date.js";

/**
 * An effective-dated fee rule.
 *
 * Rules are configuration, never code: a tenant prices its assets by shipping
 * rules, not by shipping a new release (build brief section 1.3). The engine
 * is pure so the same selection runs in production, in tests, and in any
 * adapter that needs to reproduce a quote.
 */
export interface FeeRule {
  readonly ruleId: string;
  /** Asset type this rule prices. Omitted means a default rule for every type. */
  readonly assetType?: string;
  /** Zone this rule prices. Omitted means the rule is not zone-scoped. */
  readonly zoneId?: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Inclusive YYYY-MM-DD. */
  readonly effectiveFrom: string;
  /** Inclusive YYYY-MM-DD. Omitted means the rule never expires. */
  readonly effectiveTo?: string;
}

/**
 * Precedence tiers, most specific first. A rule that falls in no tier for the
 * query is ignored (for example a rule scoped to a different zone).
 */
export type FeeRulePrecedence = "asset_type_and_zone" | "asset_type" | "default";

export interface FeeRuleQuery {
  readonly assetType: string;
  readonly zoneId?: string;
  readonly businessDate: BusinessDate;
}

export interface FeeRuleSelection {
  readonly rule: FeeRule;
  readonly precedence: FeeRulePrecedence;
}

const PRECEDENCE_ORDER: readonly FeeRulePrecedence[] = [
  "asset_type_and_zone",
  "asset_type",
  "default",
];

/** A rule applies when the business date falls inside its effective window. */
function isApplicable(rule: FeeRule, businessDate: string): boolean {
  if (rule.effectiveFrom > businessDate) return false;
  if (rule.effectiveTo !== undefined && businessDate > rule.effectiveTo) return false;
  return true;
}

/**
 * Classifies a rule against a query, or returns undefined when the rule does
 * not apply (wrong asset type, or scoped to a zone other than the queried one).
 */
function precedenceOf(rule: FeeRule, query: FeeRuleQuery): FeeRulePrecedence | undefined {
  if (rule.assetType === query.assetType) {
    if (rule.zoneId !== undefined) {
      return rule.zoneId === query.zoneId ? "asset_type_and_zone" : undefined;
    }
    return "asset_type";
  }
  if (rule.assetType === undefined && rule.zoneId === undefined) {
    return "default";
  }
  return undefined;
}

/**
 * Selects the fee rule that prices an asset on a business date.
 *
 * The most specific applicable tier wins (type+zone, then type, then default).
 * Within a tier the latest `effectiveFrom` on or before the date wins. Ties are
 * broken by `ruleId` so the result is deterministic; overlapping rules are
 * rejected when the tenant config loads, so ties only arise in hand-built rule
 * sets.
 */
export function selectFeeRule(
  rules: readonly FeeRule[],
  query: FeeRuleQuery,
): FeeRuleSelection | undefined {
  const businessDate = query.businessDate;
  let best: { rule: FeeRule; precedence: FeeRulePrecedence; rank: number } | undefined;

  for (const rule of rules) {
    if (!isApplicable(rule, businessDate)) continue;
    const precedence = precedenceOf(rule, query);
    if (precedence === undefined) continue;
    const rank = PRECEDENCE_ORDER.indexOf(precedence);

    if (best === undefined || rank < best.rank) {
      best = { rule, precedence, rank };
      continue;
    }
    if (rank > best.rank) continue;

    if (rule.effectiveFrom > best.rule.effectiveFrom) {
      best = { rule, precedence, rank };
      continue;
    }
    if (rule.effectiveFrom === best.rule.effectiveFrom && rule.ruleId < best.rule.ruleId) {
      best = { rule, precedence, rank };
    }
  }

  if (best === undefined) return undefined;
  return { rule: best.rule, precedence: best.precedence };
}
