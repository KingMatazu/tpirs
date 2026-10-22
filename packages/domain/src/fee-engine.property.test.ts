import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { selectFeeRule } from "./fee-engine.js";
import type { FeeRule, FeeRulePrecedence, FeeRuleQuery } from "./fee-engine.js";
import { businessDate } from "./business-date.js";
import { checkProperty } from "./test-support/property.js";

/**
 * A calendar date between 2020-01-01 and 2030-12-31.
 *
 * The dates are built from a day offset so they are always real calendar
 * dates, and the business date constructor can validate them.
 */
const dateStringArb = fc.integer({ min: 0, max: 4018 }).map((days) => {
  const millis = Date.UTC(2020, 0, 1) + days * 86_400_000;
  return new Date(millis).toISOString().slice(0, 10);
});

const ruleArb = fc
  .record({
    ruleId: fc.string({ minLength: 1, maxLength: 8 }),
    assetType: fc.option(fc.constantFrom("bike", "tuktuk", "bus"), { nil: null }),
    zoneId: fc.option(fc.constantFrom("zone-a", "zone-b"), { nil: null }),
    amountMinor: fc.integer({ min: 1, max: 1_000_000 }),
    currency: fc.constantFrom("NGN", "GHS"),
    effectiveFrom: dateStringArb,
    effectiveTo: fc.option(dateStringArb, { nil: null }),
  })
  .map((raw): FeeRule => ({
    ruleId: raw.ruleId,
    ...(raw.assetType === null ? {} : { assetType: raw.assetType }),
    ...(raw.zoneId === null ? {} : { zoneId: raw.zoneId }),
    amountMinor: raw.amountMinor,
    currency: raw.currency,
    effectiveFrom: raw.effectiveFrom,
    ...(raw.effectiveTo === null ? {} : { effectiveTo: raw.effectiveTo }),
  }));

const queryArb = fc.record({
  assetType: fc.constantFrom("bike", "tuktuk", "bus"),
  zoneId: fc.option(fc.constantFrom("zone-a", "zone-b"), { nil: null }),
  businessDate: dateStringArb,
});

function toQuery(raw: {
  assetType: string;
  zoneId: string | null;
  businessDate: string;
}): FeeRuleQuery {
  return {
    assetType: raw.assetType,
    ...(raw.zoneId === null ? {} : { zoneId: raw.zoneId }),
    businessDate: businessDate(raw.businessDate),
  };
}

/** The tier a rule falls in for a query, or undefined when it does not apply. */
function tierOf(rule: FeeRule, query: FeeRuleQuery): FeeRulePrecedence | undefined {
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

function appliesOn(rule: FeeRule, date: string): boolean {
  if (rule.effectiveFrom > date) return false;
  if (rule.effectiveTo !== undefined && date > rule.effectiveTo) return false;
  return true;
}

/**
 * An independent reference implementation: take the most specific tier that
 * has any applicable rule, then the latest `effectiveFrom` on or before the
 * date, breaking ties on the smallest `ruleId`.
 */
function referenceSelect(
  rules: readonly FeeRule[],
  query: FeeRuleQuery,
): { rule: FeeRule; precedence: FeeRulePrecedence } | undefined {
  const tiers: readonly FeeRulePrecedence[] = ["asset_type_and_zone", "asset_type", "default"];
  for (const tier of tiers) {
    const candidates = rules.filter(
      (rule) => tierOf(rule, query) === tier && appliesOn(rule, query.businessDate),
    );
    if (candidates.length === 0) continue;
    let best = candidates[0];
    if (best === undefined) continue;
    for (const candidate of candidates) {
      if (candidate.effectiveFrom > best.effectiveFrom) {
        best = candidate;
        continue;
      }
      if (candidate.effectiveFrom === best.effectiveFrom && candidate.ruleId < best.ruleId) {
        best = candidate;
      }
    }
    return { rule: best, precedence: tier };
  }
  return undefined;
}

describe("fee rule selection properties", () => {
  it("picks the rule the reference implementation picks", () => {
    checkProperty(
      "fee selection matches the reference",
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 8 }), queryArb, (rules, raw) => {
        const query = toQuery(raw);
        const expected = referenceSelect(rules, query);
        const actual = selectFeeRule(rules, query);
        if (expected === undefined) {
          expect(actual).toBeUndefined();
          return;
        }
        expect(actual).toBeDefined();
        if (actual === undefined) return;
        expect(actual.rule.ruleId).toBe(expected.rule.ruleId);
        expect(actual.precedence).toBe(expected.precedence);
      }),
      {
        // `examples` are tuple values, so a two-arbitrary property passes
        // `[rules, query]`.
        examples: [
          [
            [
              {
                ruleId: "old",
                assetType: "bike",
                amountMinor: 100,
                currency: "NGN",
                effectiveFrom: "2026-01-01",
                effectiveTo: "2026-06-30",
              },
              {
                ruleId: "new",
                assetType: "bike",
                amountMinor: 200,
                currency: "NGN",
                effectiveFrom: "2026-07-01",
              },
            ],
            {
              assetType: "bike",
              zoneId: null,
              businessDate: "2026-07-02",
            },
          ],
        ],
      },
    );
  });

  it("always chooses a rule that is effective on the business date", () => {
    checkProperty(
      "selected rule is effective on the date",
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 8 }), queryArb, (rules, raw) => {
        const query = toQuery(raw);
        const selected = selectFeeRule(rules, query);
        if (selected === undefined) return;
        expect(selected.rule.effectiveFrom <= query.businessDate).toBe(true);
        if (selected.rule.effectiveTo !== undefined) {
          expect(query.businessDate <= selected.rule.effectiveTo).toBe(true);
        }
      }),
    );
  });

  it("never chooses an older rule than one that also applies", () => {
    checkProperty(
      "selected rule is the latest effective one",
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 8 }), queryArb, (rules, raw) => {
        const query = toQuery(raw);
        const selected = selectFeeRule(rules, query);
        if (selected === undefined) return;
        const rivals = rules.filter(
          (rule) =>
            tierOf(rule, query) === selected.precedence && appliesOn(rule, query.businessDate),
        );
        for (const rival of rivals) {
          expect(rival.effectiveFrom <= selected.rule.effectiveFrom).toBe(true);
          if (rival.effectiveFrom === selected.rule.effectiveFrom) {
            expect(rival.ruleId >= selected.rule.ruleId).toBe(true);
          }
        }
      }),
    );
  });

  it("is deterministic", () => {
    checkProperty(
      "fee selection is deterministic",
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 8 }), queryArb, (rules, raw) => {
        const query = toQuery(raw);
        expect(selectFeeRule(rules, query)).toEqual(selectFeeRule(rules, query));
      }),
    );
  });

  it("does not depend on the order the rules are listed in", () => {
    checkProperty(
      "fee selection is order independent",
      fc.property(fc.array(ruleArb, { minLength: 0, maxLength: 8 }), queryArb, (rules, raw) => {
        const query = toQuery(raw);
        const forward = selectFeeRule(rules, query);
        const reversed = selectFeeRule([...rules].reverse(), query);
        expect(reversed?.rule.ruleId).toBe(forward?.rule.ruleId);
        expect(reversed?.precedence).toBe(forward?.precedence);
      }),
    );
  });

  it("ignores rules that apply to a different zone", () => {
    checkProperty(
      "zone scoped rules only apply to their zone",
      fc.property(
        fc.record({
          ruleId: fc.string({ minLength: 1, maxLength: 8 }),
          amountMinor: fc.integer({ min: 1, max: 1_000_000 }),
          effectiveFrom: dateStringArb,
        }),
        queryArb,
        (raw, queryRaw) => {
          const query = toQuery(queryRaw);
          const rule: FeeRule = {
            ruleId: raw.ruleId,
            assetType: query.assetType,
            zoneId: "zone-a",
            amountMinor: raw.amountMinor,
            currency: "NGN",
            effectiveFrom: raw.effectiveFrom,
          };
          const selected = selectFeeRule([rule], query);
          const effective = raw.effectiveFrom <= query.businessDate;
          if (query.zoneId === "zone-a" && effective) {
            expect(selected?.rule.ruleId).toBe(rule.ruleId);
          } else {
            expect(selected).toBeUndefined();
          }
        },
      ),
    );
  });
});
