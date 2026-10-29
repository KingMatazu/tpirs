import { DomainError } from "./errors.js";
import type { BusinessDate } from "./business-date.js";
import { addDays } from "./business-date.js";

/**
 * Anomaly rules (ADR 0039, D46).
 *
 * An anomaly is a subject deviating from its own trailing baseline — never the
 * absence of payments for a single asset. Under `pay_per_use` an idle vehicle
 * owes nothing, so "asset" is not a subject type at all: the evaluation
 * functions reject it, which makes the build-brief guarantee type-level rather
 * than a matter of remembering not to pass one.
 *
 * Every rule is a pure function over a trailing window of per-day values. The
 * caller gathers each subject's series (the database decides how), the domain
 * decides only whether the observation against the baseline fires.
 */

/** What anomalies observe. Deliberately excludes "asset". */
export type AnomalySubjectType = "collector" | "zone" | "officer" | "tenant";

export const ANOMALY_SUBJECT_TYPES: readonly AnomalySubjectType[] = [
  "collector",
  "zone",
  "officer",
  "tenant",
];

export type AnomalyRuleKey =
  | "collector_volume_drop"
  | "collector_deposit_lag"
  | "zone_compliance_drop"
  | "officer_scan_volume_change"
  | "suspense_growth";

export const ANOMALY_RULES: readonly AnomalyRuleKey[] = [
  "collector_volume_drop",
  "collector_deposit_lag",
  "zone_compliance_drop",
  "officer_scan_volume_change",
  "suspense_growth",
];

/** How a rule compares its observation to the baseline. */
export type AnomalyRuleKind =
  /** Falls below the trailing mean by more than `thresholdPercent`. */
  | "percent_drop"
  /** Moves away from the trailing mean, either direction, past `thresholdPercent`. */
  | "percent_change"
  /** Exceeds an absolute amount of money (`thresholdMinor`). */
  | "absolute_minor"
  /** Present at all: a count of explicit conditions above zero. */
  | "presence";

const RULE_KINDS: Readonly<Record<AnomalyRuleKey, AnomalyRuleKind>> = {
  collector_volume_drop: "percent_drop",
  collector_deposit_lag: "presence",
  zone_compliance_drop: "percent_drop",
  officer_scan_volume_change: "percent_change",
  suspense_growth: "absolute_minor",
};

export function anomalyRuleKind(rule: AnomalyRuleKey): AnomalyRuleKind {
  return RULE_KINDS[rule];
}

export type AnomalySeverity = "warning" | "info";

export class AnomalyError extends DomainError {
  readonly code: AnomalyErrorCode;

  constructor(code: AnomalyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type AnomalyErrorCode = "unknown_rule" | "unknown_subject" | "invalid_rule";

/**
 * One configured rule. All values are carried as typed primitives; the tenant
 * config (Step 5) maps its YAML keys onto this shape so the domain never reads
 * tenant YAML.
 */
export interface AnomalyRule {
  readonly key: AnomalyRuleKey;
  readonly severity: AnomalySeverity;
  /** Length of the trailing baseline window, in days. */
  readonly windowDays: number;
  /** Percent deviation required to fire; used by the percent rules. */
  readonly thresholdPercent?: number;
  /**
   * Rule-specific absolute knob, minor units. For `suspense_growth` it is the
   * ceiling the suspense total must stay below; for `collector_deposit_lag`
   * it is the count of lagging intakes allowed before firing.
   */
  readonly thresholdMinor?: number;
}

/** Asserts a configured rule can be evaluated at all. */
export function validateAnomalyRule(rule: AnomalyRule): void {
  if (!ANOMALY_RULES.includes(rule.key)) {
    throw new AnomalyError("unknown_rule", `Unknown anomaly rule "${rule.key}"`);
  }
  if (!Number.isInteger(rule.windowDays) || rule.windowDays < 1) {
    throw new AnomalyError(
      "invalid_rule",
      `Rule ${rule.key} needs a whole-number window of at least one day`,
    );
  }
  if (rule.thresholdPercent !== undefined) {
    if (!Number.isFinite(rule.thresholdPercent) || rule.thresholdPercent <= 0) {
      throw new AnomalyError(
        "invalid_rule",
        `Rule ${rule.key} needs a positive deviation threshold`,
      );
    }
  }
  if (rule.thresholdMinor !== undefined) {
    if (!Number.isInteger(rule.thresholdMinor) || rule.thresholdMinor < 0) {
      throw new AnomalyError(
        "invalid_rule",
        `Rule ${rule.key} needs a non-negative integer threshold`,
      );
    }
  }
  switch (anomalyRuleKind(rule.key)) {
    case "percent_drop":
    case "percent_change":
      if (rule.thresholdPercent === undefined) {
        throw new AnomalyError(
          "invalid_rule",
          `Rule ${rule.key} is a percent rule and needs a thresholdPercent`,
        );
      }
      break;
    case "absolute_minor":
      if (rule.thresholdMinor === undefined) {
        throw new AnomalyError(
          "invalid_rule",
          `Rule ${rule.key} is an absolute rule and needs a thresholdMinor`,
        );
      }
      break;
    case "presence":
      break;
  }
}

/**
 * The baseline window a rule observes, in the tenant's business calendar.
 *
 * The window is the `windowDays` days strictly *before* `evaluationDate`; the
 * observed value is the evaluation day itself. `window_end` is the day before
 * the evaluation, which is also the persistence dedupe key, so re-running the
 * same evaluation day never repeats an alert.
 */
export function anomalyWindow(
  rule: AnomalyRule,
  evaluationDate: BusinessDate,
): { windowStart: BusinessDate; windowEnd: BusinessDate } {
  const windowEnd = addDays(evaluationDate, -1);
  return { windowStart: addDays(windowEnd, -(rule.windowDays - 1)), windowEnd };
}

/**
 * The stable repeat identity of an evaluation, used where a dedupe key beyond
 * the `(rule, subject, window)` table key is needed (for example in telemetry
 * attributes).
 */
export function anomalyDedupeKey(
  ruleKey: AnomalyRuleKey,
  subjectType: AnomalySubjectType,
  subjectId: string,
  windowEnd: BusinessDate,
): string {
  return `${ruleKey}:${subjectType}:${subjectId}:${windowEnd}`;
}

export interface AnomalyEvaluation {
  readonly ruleKey: AnomalyRuleKey;
  readonly severity: AnomalySeverity;
  readonly subjectType: AnomalySubjectType;
  readonly subjectId: string;
  /** The observed value, serialised exactly as it will be persisted. */
  readonly observed: string;
  /** The baseline the observation is judged against, serialised. */
  readonly baseline: string;
  /** The threshold that decided the outcome, serialised. */
  readonly threshold: string;
  readonly fires: boolean;
  readonly detail: Record<string, unknown>;
}

export interface EvaluateAnomalyInput {
  readonly rule: AnomalyRule;
  readonly subjectType: AnomalySubjectType;
  readonly subjectId: string;
  /**
   * The value on the evaluation day. For count rules this is a count; for the
   * absolute rule it is a minor-unit total (carried as number so one function
   * serves both; minor-unit magnitudes stay inside safe integers).
   */
  readonly observed: number;
  /**
   * One value per baseline window day, in day order from oldest to newest.
   * Days without data are simply absent: the baseline is the mean of the days
   * that do have data, not of the calendar span.
   */
  readonly baselineValues: readonly number[];
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Evaluates one rule for one subject on one evaluation day.
 *
 * Percent rules need a living baseline: when the trailing mean is zero there
 * is nothing to deviate from, so the rule stays silent rather than dividing by
 * zero — a brand-new collector is onboarding noise, not an anomaly, and the
 * tuning work that fires on tiny baselines belongs to real pilot data (D46).
 * All rules are off in `tenants/_template` until a tenant opts in.
 */
export function evaluateAnomalyRule(input: EvaluateAnomalyInput): AnomalyEvaluation {
  const { rule } = input;
  validateAnomalyRule(rule);
  if (!ANOMALY_SUBJECT_TYPES.includes(input.subjectType)) {
    throw new AnomalyError(
      "unknown_subject",
      `"${input.subjectType}" is not an anomaly subject; assets never deviate, they just idle`,
    );
  }

  const baseline = meanOf(input.baselineValues);
  const threshold = rule.thresholdPercent ?? rule.thresholdMinor ?? 0;

  let fires: boolean;
  switch (anomalyRuleKind(rule.key)) {
    case "percent_drop": {
      const percent = rule.thresholdPercent ?? 0;
      fires = baseline > 0 && input.observed < baseline * (1 - percent / 100);
      break;
    }
    case "percent_change": {
      const percent = rule.thresholdPercent ?? 0;
      fires = baseline > 0 && Math.abs(input.observed - baseline) > baseline * (percent / 100);
      break;
    }
    case "absolute_minor": {
      fires = input.observed > (rule.thresholdMinor ?? 0);
      break;
    }
    case "presence": {
      // "Present at all": for deposit lag the observed value is the count of
      // intakes past the deadline, and any one of them is an event. The rule's
      // `thresholdMinor` is the deadline multiple the service applied when
      // counting, not a count allowance.
      fires = input.observed > 0;
      break;
    }
  }

  return {
    ruleKey: rule.key,
    severity: rule.severity,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    observed: String(input.observed),
    baseline: baseline.toString(),
    threshold: String(threshold),
    fires,
    detail: {
      observations: input.baselineValues.length,
      thresholdPercent: rule.thresholdPercent ?? null,
      thresholdMinor: rule.thresholdMinor ?? null,
    },
  };
}
