import { describe, expect, it } from "vitest";
import {
  ANOMALY_SUBJECT_TYPES,
  anomalyDedupeKey,
  anomalyRuleKind,
  anomalyWindow,
  AnomalyError,
  evaluateAnomalyRule,
  validateAnomalyRule,
} from "./anomaly.js";
import type { AnomalyRule } from "./anomaly.js";
import { businessDate } from "./business-date.js";

function rule(overrides: Partial<AnomalyRule> = {}): AnomalyRule {
  return {
    key: "collector_volume_drop",
    severity: "warning",
    windowDays: 14,
    thresholdPercent: 30,
    ...overrides,
  };
}

describe("rule kinds and validation", () => {
  it("maps each rule key to its comparison kind", () => {
    expect(anomalyRuleKind("collector_volume_drop")).toBe("percent_drop");
    expect(anomalyRuleKind("zone_compliance_drop")).toBe("percent_drop");
    expect(anomalyRuleKind("officer_scan_volume_change")).toBe("percent_change");
    expect(anomalyRuleKind("suspense_growth")).toBe("absolute_minor");
    expect(anomalyRuleKind("collector_deposit_lag")).toBe("presence");
  });

  it("rejects an unknown rule key", () => {
    expect(() => validateAnomalyRule({ ...rule(), key: "asset_goes_silent" as never })).toThrow(
      AnomalyError,
    );
  });

  it("requires a percent threshold on percent rules", () => {
    expect(() =>
      validateAnomalyRule({ key: "collector_volume_drop", severity: "warning", windowDays: 14 }),
    ).toThrow(/thresholdPercent/);
  });

  it("requires a minor-unit ceiling on the absolute rule", () => {
    expect(() =>
      validateAnomalyRule({ key: "suspense_growth", severity: "warning", windowDays: 14 }),
    ).toThrow(/thresholdMinor/);
  });

  it("rejects a non-positive window", () => {
    expect(() => validateAnomalyRule(rule({ windowDays: 0 }))).toThrow(AnomalyError);
  });
});

describe("subject types", () => {
  it("never treats an asset as an anomaly subject: an idle vehicle owes nothing", () => {
    // The build brief's hard rule: "a vehicle with no payments is not an
    // anomaly". The subject vocabulary has no "asset" member, so an asset
    // series cannot be smuggled into the evaluation.
    expect(ANOMALY_SUBJECT_TYPES).not.toContain("asset");
    expect(() =>
      evaluateAnomalyRule({
        rule: rule(),
        subjectType: "asset" as never,
        subjectId: "asset-1",
        observed: 0,
        baselineValues: Array.from({ length: 14 }, () => 1),
      }),
    ).toThrow(/asset/);
  });
});

describe("anomaly windows", () => {
  it("spans the trailing baseline days before the evaluation day", () => {
    const window = anomalyWindow(rule({ windowDays: 14 }), businessDate("2026-10-15"));
    expect(window.windowEnd).toBe("2026-10-14");
    expect(window.windowStart).toBe("2026-10-01");
  });

  it("uses a one-day window without underflow", () => {
    const window = anomalyWindow(rule({ windowDays: 1 }), businessDate("2026-10-15"));
    expect(window.windowEnd).toBe("2026-10-14");
    expect(window.windowStart).toBe("2026-10-14");
  });

  it("builds stable dedupe keys per rule, subject and window", () => {
    expect(anomalyDedupeKey("zone_compliance_drop", "zone", "z1", businessDate("2026-10-14"))).toBe(
      "zone_compliance_drop:zone:z1:2026-10-14",
    );
  });
});

describe("percent drop rules", () => {
  it("fires when the observation falls below the baseline by more than the threshold", () => {
    // Trailing mean 10 (3 + 10 + 17) / 3; a drop past 30% means below 7.
    const evaluation = evaluateAnomalyRule({
      rule: rule(),
      subjectType: "collector",
      subjectId: "c1",
      observed: 6,
      baselineValues: [3, 10, 17],
    });
    expect(evaluation.fires).toBe(true);
    expect(evaluation.baseline).toBe("10");
    expect(evaluation.threshold).toBe("30");
  });

  it("stays silent exactly at the threshold, which is exclusive rather than inclusive", () => {
    // Observed 7 is exactly a 30% drop from mean 10; "more than" is required.
    const evaluation = evaluateAnomalyRule({
      rule: rule(),
      subjectType: "collector",
      subjectId: "c1",
      observed: 7,
      baselineValues: Array.from({ length: 14 }, () => 10),
    });
    expect(evaluation.fires).toBe(false);
  });

  it("never fires on a zero baseline: an unknown subject has nothing to deviate from", () => {
    const evaluation = evaluateAnomalyRule({
      rule: rule(),
      subjectType: "collector",
      subjectId: "new-collector",
      observed: 5,
      baselineValues: [0, 0, 0, 0],
    });
    expect(evaluation.fires).toBe(false);
  });

  it("uses only the days that carry a measurement", () => {
    // A day in the window without a measurement for the subject is absent from
    // the series entirely; a day where the subject genuinely did nothing is a
    // real zero and stays in the mean.
    const evaluation = evaluateAnomalyRule({
      rule: rule({ thresholdPercent: 50 }),
      subjectType: "collector",
      subjectId: "sparse",
      observed: 2,
      baselineValues: [4, 8],
    });
    expect(evaluation.fires).toBe(true);
    expect(evaluation.baseline).toBe("6");
    const quietDays = evaluateAnomalyRule({
      rule: rule({ thresholdPercent: 50 }),
      subjectType: "collector",
      subjectId: "sparse",
      observed: 2,
      baselineValues: [4, 0, 0, 8],
    });
    expect(quietDays.fires).toBe(false);
  });
});

describe("percent change rules", () => {
  it("fires when scans move away from the baseline in either direction", () => {
    const values = Array.from({ length: 10 }, () => 50);
    const up = evaluateAnomalyRule({
      rule: rule({ key: "officer_scan_volume_change", thresholdPercent: 20 }),
      subjectType: "officer",
      subjectId: "o1",
      observed: 70,
      baselineValues: values,
    });
    const down = evaluateAnomalyRule({
      rule: rule({ key: "officer_scan_volume_change", thresholdPercent: 20 }),
      subjectType: "officer",
      subjectId: "o1",
      observed: 30,
      baselineValues: values,
    });
    const calm = evaluateAnomalyRule({
      rule: rule({ key: "officer_scan_volume_change", thresholdPercent: 20 }),
      subjectType: "officer",
      subjectId: "o1",
      observed: 55,
      baselineValues: values,
    });
    expect(up.fires).toBe(true);
    expect(down.fires).toBe(true);
    expect(calm.fires).toBe(false);
  });
});

describe("absolute and presence rules", () => {
  it("fires suspense growth above the configured ceiling only", () => {
    const growth = rule({ key: "suspense_growth", thresholdMinor: 100_000, severity: "warning" });
    const below = evaluateAnomalyRule({
      rule: growth,
      subjectType: "tenant",
      subjectId: "t",
      observed: 100_000,
      baselineValues: [],
    });
    const above = evaluateAnomalyRule({
      rule: growth,
      subjectType: "tenant",
      subjectId: "t",
      observed: 100_050,
      baselineValues: [],
    });
    expect(below.fires).toBe(false);
    expect(above.fires).toBe(true);
    expect(above.observed).toBe("100050");
  });

  it("fires deposit lag as soon as any intake is past the deadline", () => {
    const lag = rule({ key: "collector_deposit_lag", thresholdMinor: 1 });
    const evaluation = evaluateAnomalyRule({
      rule: lag,
      subjectType: "collector",
      subjectId: "c1",
      observed: 1,
      baselineValues: [],
    });
    expect(evaluation.fires).toBe(true);
    const quiet = evaluateAnomalyRule({
      rule: lag,
      subjectType: "collector",
      subjectId: "c1",
      observed: 0,
      baselineValues: [],
    });
    expect(quiet.fires).toBe(false);
  });
});
