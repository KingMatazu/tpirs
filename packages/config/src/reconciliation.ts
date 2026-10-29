import type { AnomalyRule } from "@tpirs/domain";
import type { TenantConfig } from "./schema.js";

/**
 * The anomaly rules the nightly evaluation should run, as the domain expects
 * them.
 *
 * Config carries `enabled` because every rule ships disabled until pilot data
 * exists (D46); the domain never sees a disabled rule, so it cannot accidentally
 * evaluate one. The mapping is intentionally field-for-field: the config keys
 * are the domain's rule keys, and `severity` is already the advisory vocabulary.
 */
export function enabledAnomalyRules(config: TenantConfig): readonly AnomalyRule[] {
  return config.reconciliation.anomalyRules
    .filter((rule) => rule.enabled)
    .map((rule) => ({
      key: rule.key,
      severity: rule.severity,
      windowDays: rule.windowDays,
      ...(rule.thresholdPercent === undefined ? {} : { thresholdPercent: rule.thresholdPercent }),
      ...(rule.thresholdMinor === undefined ? {} : { thresholdMinor: rule.thresholdMinor }),
    }));
}
