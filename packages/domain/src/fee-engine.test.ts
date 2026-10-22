import { describe, expect, it } from "vitest";
import { businessDate } from "./business-date.js";
import { selectFeeRule } from "./fee-engine.js";
import type { FeeRule } from "./fee-engine.js";

function rule(overrides: Partial<FeeRule> & Pick<FeeRule, "ruleId">): FeeRule {
  return {
    amountMinor: 100,
    currency: "NGN",
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

describe("selectFeeRule", () => {
  it("selects the rule for the asset type", () => {
    const rules = [
      rule({ ruleId: "bike", assetType: "bike", amountMinor: 100 }),
      rule({ ruleId: "tuktuk", assetType: "tuktuk", amountMinor: 200 }),
    ];
    const selection = selectFeeRule(rules, {
      assetType: "tuktuk",
      businessDate: businessDate("2026-03-01"),
    });
    expect(selection?.rule.ruleId).toBe("tuktuk");
    expect(selection?.precedence).toBe("asset_type");
  });

  it("selects the latest effective rule on or before the date", () => {
    const rules = [
      rule({
        ruleId: "bike-old",
        assetType: "bike",
        amountMinor: 100,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      }),
      rule({
        ruleId: "bike-new",
        assetType: "bike",
        amountMinor: 150,
        effectiveFrom: "2026-07-01",
      }),
    ];
    expect(
      selectFeeRule(rules, { assetType: "bike", businessDate: businessDate("2026-05-01") })?.rule
        .ruleId,
    ).toBe("bike-old");
    expect(
      selectFeeRule(rules, { assetType: "bike", businessDate: businessDate("2026-07-01") })?.rule
        .ruleId,
    ).toBe("bike-new");
    expect(
      selectFeeRule(rules, { assetType: "bike", businessDate: businessDate("2026-12-31") })?.rule
        .ruleId,
    ).toBe("bike-new");
  });

  it("treats effectiveTo as inclusive", () => {
    const rules = [
      rule({
        ruleId: "bike",
        assetType: "bike",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      }),
    ];
    expect(
      selectFeeRule(rules, { assetType: "bike", businessDate: businessDate("2026-06-30") })?.rule
        .ruleId,
    ).toBe("bike");
    expect(
      selectFeeRule(rules, { assetType: "bike", businessDate: businessDate("2026-07-01") }),
    ).toBeUndefined();
  });

  it("ignores rules that are not yet effective", () => {
    const rules = [rule({ ruleId: "bike", assetType: "bike", effectiveFrom: "2026-07-01" })];
    expect(
      selectFeeRule(rules, { assetType: "bike", businessDate: businessDate("2026-06-30") }),
    ).toBeUndefined();
  });

  it("falls back to a default rule when the asset type has none", () => {
    const rules = [
      rule({ ruleId: "bike", assetType: "bike", amountMinor: 100 }),
      rule({ ruleId: "default", amountMinor: 50 }),
    ];
    const selection = selectFeeRule(rules, {
      assetType: "truck",
      businessDate: businessDate("2026-03-01"),
    });
    expect(selection?.rule.ruleId).toBe("default");
    expect(selection?.precedence).toBe("default");
  });

  it("prefers a type rule over a default rule", () => {
    const rules = [
      rule({ ruleId: "default", amountMinor: 50, effectiveFrom: "2026-01-01" }),
      rule({ ruleId: "bike", assetType: "bike", amountMinor: 100, effectiveFrom: "2026-01-01" }),
    ];
    const selection = selectFeeRule(rules, {
      assetType: "bike",
      businessDate: businessDate("2026-03-01"),
    });
    expect(selection?.rule.ruleId).toBe("bike");
    expect(selection?.precedence).toBe("asset_type");
  });

  it("prefers a type and zone rule over a type rule", () => {
    const rules = [
      rule({ ruleId: "bike", assetType: "bike", amountMinor: 100 }),
      rule({ ruleId: "bike-zone", assetType: "bike", zoneId: "zone-a", amountMinor: 120 }),
    ];
    const selection = selectFeeRule(rules, {
      assetType: "bike",
      zoneId: "zone-a",
      businessDate: businessDate("2026-03-01"),
    });
    expect(selection?.rule.ruleId).toBe("bike-zone");
    expect(selection?.precedence).toBe("asset_type_and_zone");
  });

  it("ignores a zone rule scoped to another zone", () => {
    const rules = [
      rule({ ruleId: "bike", assetType: "bike", amountMinor: 100 }),
      rule({ ruleId: "bike-zone", assetType: "bike", zoneId: "zone-a", amountMinor: 120 }),
    ];
    const selection = selectFeeRule(rules, {
      assetType: "bike",
      zoneId: "zone-b",
      businessDate: businessDate("2026-03-01"),
    });
    expect(selection?.rule.ruleId).toBe("bike");
    expect(selection?.precedence).toBe("asset_type");
  });

  it("returns undefined when no rule applies", () => {
    const rules = [rule({ ruleId: "bike", assetType: "bike" })];
    expect(
      selectFeeRule(rules, { assetType: "truck", businessDate: businessDate("2026-03-01") }),
    ).toBeUndefined();
  });
});
