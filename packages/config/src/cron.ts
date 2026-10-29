/**
 * Structural validation for the tenant reconciliation schedule.
 *
 * The worker turns the expression into the next occurrence with `cron-parser`
 * behind one helper (D48/ADR 0040); this validator is the load-time gate so a
 * typo fails when the tenant config is written, not at 02:00 when nobody is
 * watching. It accepts the numeric five-field subset the template documents —
 * `*`, a number, a range, and stepped forms of those — and rejects macros,
 * names and out-of-range values with a message that names the field.
 */

interface CronField {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const CRON_FIELDS: readonly CronField[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 6 },
];

function isWholeNumber(value: string): boolean {
  return /^\d+$/.test(value);
}

function cronItemError(item: string, field: CronField): string | undefined {
  const parts = item.split("/");
  if (parts.length > 2) return `"${item}" has more than one "/"`;
  const [range = "", stepText] = parts;
  if (range === "") return "empty list item";

  let step: number | undefined;
  if (stepText !== undefined) {
    if (!isWholeNumber(stepText)) return `step "${stepText}" must be a whole number`;
    step = Number(stepText);
    if (step < 1) return "step must be at least 1";
  }

  if (range === "*") return undefined;

  const bounds = range.split("-");
  if (bounds.length === 1) {
    if (!isWholeNumber(range)) {
      return `"${range}" is not a number, "*", or a range "a-b"`;
    }
    if (step !== undefined) return `a step needs a range, not the single value "${range}"`;
    const value = Number(range);
    if (value < field.min || value > field.max) {
      return `${value} is outside ${field.min}-${field.max}`;
    }
    return undefined;
  }

  if (bounds.length !== 2) return `"${range}" is not a number, "*", or a range "a-b"`;
  const [fromText = "", toText = ""] = bounds;
  if (!isWholeNumber(fromText) || !isWholeNumber(toText)) {
    return `"${range}" is not a numeric range`;
  }
  const from = Number(fromText);
  const to = Number(toText);
  if (from < field.min || from > field.max || to < field.min || to > field.max) {
    return `${range} is outside ${field.min}-${field.max}`;
  }
  if (from > to) return `range ${range} starts after it ends`;
  return undefined;
}

/**
 * The reason `expression` is not a usable five-field cron, or undefined when it
 * is. Messages are operator-facing and name the offending field.
 */
export function cronExpressionError(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`;
  }
  for (const [index, fieldText] of fields.entries()) {
    const field = CRON_FIELDS[index];
    if (field === undefined) continue;
    for (const item of fieldText.split(",")) {
      const error = cronItemError(item, field);
      if (error !== undefined) return `${field.name} field "${fieldText}": ${error}`;
    }
  }
  return undefined;
}

/** True when the expression passes {@link cronExpressionError}. */
export function isCronExpression(expression: string): boolean {
  return cronExpressionError(expression) === undefined;
}
