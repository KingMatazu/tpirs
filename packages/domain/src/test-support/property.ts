import fc from "fast-check";
import type { IProperty, Parameters as FastCheckParameters } from "fast-check";

/**
 * How many generated cases a property runs by default.
 *
 * CI keeps the default small so the suite stays fast; the nightly job raises
 * it with `FAST_CHECK_RUNS` to explore a much larger space.
 */
export const DEFAULT_PROPERTY_RUNS = 100;

/**
 * The number of runs the current environment asks for.
 *
 * `FAST_CHECK_RUNS` is read from the environment so the CI workflow can raise
 * the count for the nightly job without touching the test code.
 */
export function propertyRunCount(): number {
  const raw = process.env["FAST_CHECK_RUNS"];
  if (raw === undefined) return DEFAULT_PROPERTY_RUNS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROPERTY_RUNS;
  return parsed;
}

/**
 * Runs a property and, when it fails, logs the seed and the shrunk
 * counterexample.
 *
 * The seed is what makes a failure reproducible: re-running with the same
 * seed reproduces the exact counterexample, so a failure can be turned into a
 * fixed `examples:` entry instead of a flaky report.
 */
export function checkProperty<T>(
  name: string,
  property: IProperty<T>,
  options: FastCheckParameters<T> = {},
): void {
  const details = fc.check(property, {
    numRuns: propertyRunCount(),
    endOnFailure: true,
    ...options,
  });
  if (!details.failed) return;

  console.error(
    `[fast-check] ${name} failed: seed=${details.seed} ` +
      `path=${details.counterexamplePath ?? "n/a"} runs=${details.numRuns}`,
  );
  if (details.counterexample !== null) {
    console.error(`[fast-check] counterexample: ${fc.stringify(details.counterexample)}`);
  }
  if (details.errorInstance !== null && details.errorInstance !== undefined) {
    const cause: unknown = details.errorInstance;
    const causeText =
      cause instanceof Error ? cause.message : Object.prototype.toString.call(cause);
    console.error(`[fast-check] cause: ${causeText}`);
  }
  throw new Error(fc.defaultReportMessage(details) ?? `property ${name} failed`);
}
