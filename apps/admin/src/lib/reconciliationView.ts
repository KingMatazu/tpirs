/**
 * Pure helpers behind the reconciliation screen (Step 8).
 *
 * The page is an arrangement of queries and forms; the interesting rules live
 * here so they can be unit-tested without rendering: how a run status reads,
 * which tone a severity carries, what a checklist adds up to, and which query
 * string an empty filter must *not* send. Nothing here touches React, the
 * client, or the DOM.
 *
 * The wire shapes mirror the generated contract (`ReconciliationRun`,
 * `ReconciliationChecklistItem`, `ReconciliationException`). Money is a
 * minor-unit string and business days are `YYYY-MM-DD`, exactly as the API
 * sends them.
 */

export type RunStatus = "running" | "completed" | "failed" | "signed_off";
export type Severity = "blocking" | "warning" | "info";
export type ExceptionStatus = "open" | "resolved" | "waived";

/**
 * The badge tones the dashboard understands. Kept in step with
 * `components/ui.tsx`; the page never builds a colour class itself.
 */
export type Tone = "neutral" | "brand" | "positive" | "warning" | "danger";

/** One checklist entry as the run detail returns it. */
export interface ChecklistItemView {
  readonly check: string;
  readonly severity: Severity;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly expectedMinor: string | null;
  readonly actualMinor: string | null;
  readonly expectedCount: number | null;
  readonly actualCount: number | null;
  readonly differenceMinor: string | null;
  readonly differenceCount: number | null;
  readonly withinTolerance: boolean | null;
}

/** One reconciliation run (`GET /v1/reconciliation/runs` and `/{id}`). */
export interface ReconciliationRunView {
  readonly id: string;
  readonly businessDate: string;
  readonly runSeq: number;
  readonly status: RunStatus;
  readonly toleranceMinor: string;
  readonly feeToleranceMinor: string;
  readonly checklist: readonly ChecklistItemView[];
  readonly exceptionCount: number;
  readonly failureReason: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly signedOffByUserId: string | null;
  readonly signedOffAt: string | null;
  readonly signOffNote: string | null;
}

/** One queued exception (`GET /v1/reconciliation/exceptions`). */
export interface ReconciliationExceptionView {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly status: ExceptionStatus;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly businessDate: string;
  readonly expectedMinor: string | null;
  readonly actualMinor: string | null;
  readonly differenceMinor: string | null;
  readonly currency: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly resolutionNote: string | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAt: string | null;
  readonly firstSeenRunId: string;
  readonly lastSeenRunId: string;
  readonly createdAt: string;
}

export interface BusinessDateRange {
  readonly from: string;
  readonly to: string;
}

/** How many business days the run list and the report picker open on. */
export const DEFAULT_RANGE_BUSINESS_DAYS = 7;

/** Human labels for the checklist checks the reconciliation service emits. */
const CHECK_LABELS: Readonly<Record<string, string>> = {
  settlement_rows_matched: "Every statement row is matched to a payment",
  settlement_amounts: "Statement amounts agree within the fee tolerance",
  clearing_balance: "Gateway clearing balance is zero",
  ledger_balances: "Debits equal credits for the day",
  revenue_recognised: "Recognised revenue matches paid obligations",
  cash_float: "Collector float equals intakes minus posted deposits",
  cash_overdue: "No intake is past the deposit deadline",
  suspense_ageing: "Suspense items are inside the ageing window",
  duplicate_references: "No provider reference appears twice",
};

/** Human labels for the subject types an exception can point at. */
const SUBJECT_LABELS: Readonly<Record<string, string>> = {
  tenant: "Tenant",
  collector: "Collector",
  provider: "Provider",
  payment: "Payment",
  deposit: "Deposit",
  asset: "Asset",
  zone: "Zone",
  officer: "Officer",
};

/**
 * Turns a snake_case enum value into a readable phrase. The fallback matters:
 * a check or subject type added by a later service must still render as words
 * rather than as a raw key or an empty cell.
 */
function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  if (words === "") return "—";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Status of a run, as finance reads it. */
export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "signed_off":
      return "Signed off";
  }
}

/**
 * Badge tone for a run: signed off is the brand accent (the day is closed),
 * completed is positive, a failure is red, and a run in flight is neutral.
 */
export function runStatusTone(status: RunStatus): Tone {
  switch (status) {
    case "running":
      return "neutral";
    case "completed":
      return "positive";
    case "failed":
      return "danger";
    case "signed_off":
      return "brand";
  }
}

/** A check's severity, spelled out for the badge. */
export function severityLabel(severity: Severity): string {
  switch (severity) {
    case "blocking":
      return "Blocking";
    case "warning":
      return "Warning";
    case "info":
      return "Info";
  }
}

/** A blocking finding is red; a warning is amber; information is neutral. */
export function severityTone(severity: Severity): Tone {
  switch (severity) {
    case "blocking":
      return "danger";
    case "warning":
      return "warning";
    case "info":
      return "neutral";
  }
}

/** An exception's lifecycle state, spelled out. */
export function exceptionStatusLabel(status: ExceptionStatus): string {
  switch (status) {
    case "open":
      return "Open";
    case "resolved":
      return "Resolved";
    case "waived":
      return "Waived";
  }
}

/** Open work is amber; a resolution is positive; a waiver is neutral. */
export function exceptionStatusTone(status: ExceptionStatus): Tone {
  switch (status) {
    case "open":
      return "warning";
    case "resolved":
      return "positive";
    case "waived":
      return "neutral";
  }
}

/** The sentence shown next to a checklist check. */
export function checklistItemLabel(check: string): string {
  return CHECK_LABELS[check] ?? humanizeKey(check);
}

/** Whether a check passed, failed, or could not be compared. */
export function toleranceLabel(item: ChecklistItemView): string {
  if (item.withinTolerance === null) return "Not compared";
  return item.withinTolerance ? "Within tolerance" : "Outside tolerance";
}

export interface ChecklistSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Failures that carry a `blocking` severity: sign-off stays refused. */
  readonly blockingFailures: number;
  readonly notCompared: number;
}

/**
 * Adds a checklist up. `failed` is the number finance must clear before
 * sign-off; `blockingFailures` is the subset the server also refuses on, so a
 * page can explain *why* the button is missing without re-deriving severity.
 */
export function checklistSummary(items: readonly ChecklistItemView[]): ChecklistSummary {
  let passed = 0;
  let failed = 0;
  let blockingFailures = 0;
  let notCompared = 0;
  for (const item of items) {
    if (item.withinTolerance === null) {
      notCompared += 1;
    } else if (item.withinTolerance) {
      passed += 1;
    } else {
      failed += 1;
      if (item.severity === "blocking") blockingFailures += 1;
    }
  }
  return { total: items.length, passed, failed, blockingFailures, notCompared };
}

/** The run-list filter as the query string understands it. */
export interface RunFilters {
  readonly from?: string;
  readonly to?: string;
  readonly status?: string;
}

export interface RunQueryParams {
  readonly from: string;
  readonly to: string;
  readonly status?: string;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Builds the run-list querystring. Empty filters are omitted rather than sent
 * as `status=`, which the server would treat as an unknown enum value.
 */
export function reconciliationQueryParams(filters: RunFilters): RunQueryParams {
  return {
    from: filters.from?.trim() ?? "",
    to: filters.to?.trim() ?? "",
    ...(present(filters.status) ? { status: filters.status.trim() } : {}),
  };
}

export interface ExceptionFilters {
  readonly status?: string;
  readonly severity?: string;
}

export interface ExceptionQueryParams {
  readonly status?: string;
  readonly severity?: string;
}

/** Same rule for the exception queue: an empty select sends no filter at all. */
export function exceptionQueryParams(filters: ExceptionFilters): ExceptionQueryParams {
  return {
    ...(present(filters.status) ? { status: filters.status.trim() } : {}),
    ...(present(filters.severity) ? { severity: filters.severity.trim() } : {}),
  };
}

/** Filter choices rendered by the queue. `""` means "all". */
export const EXCEPTION_STATUS_OPTIONS: readonly {
  readonly value: ExceptionStatus | "";
  readonly label: string;
}[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "waived", label: "Waived" },
  { value: "", label: "All statuses" },
];

export const EXCEPTION_SEVERITY_OPTIONS: readonly {
  readonly value: Severity | "";
  readonly label: string;
}[] = [
  { value: "", label: "All severities" },
  { value: "blocking", label: "Blocking" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
];

/**
 * What an exception is about, in words: the subject type plus its identifier.
 * The identifier is opaque, so it is shown verbatim for the operator to search
 * with — never prettified.
 */
export function describeExceptionSubject(exception: {
  readonly subjectType: string;
  readonly subjectId: string;
}): string {
  const label = SUBJECT_LABELS[exception.subjectType] ?? humanizeKey(exception.subjectType);
  const id = exception.subjectId.trim();
  return id === "" ? label : `${label} ${id}`;
}

/** The sign-off body: exactly the note the contract requires, trimmed. */
export function signOffBody(note: string): { readonly note: string } {
  return { note: note.trim() };
}

/** The resolve/waive body: the same single-field shape, trimmed. */
export function resolutionBody(note: string): { readonly note: string } {
  return { note: note.trim() };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The last `count` business days ending on `today`, as an inclusive range.
 *
 * Saturdays and Sundays are skipped (the tenant's holidays are the server's
 * business; this is only the range the screen opens on and the user can change
 * it). UTC parts are used so the helper is deterministic in tests.
 */
export function lastBusinessDays(today: Date, count: number): BusinessDateRange {
  const to = isoDate(today);
  let remaining = Math.max(1, count);
  let cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  while (remaining > 0) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
    if (remaining === 0) break;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  return { from: isoDate(cursor), to };
}

/** The range the reconciliation screen opens on: the last seven business days. */
export function defaultReconciliationRange(today: Date): BusinessDateRange {
  return lastBusinessDays(today, DEFAULT_RANGE_BUSINESS_DAYS);
}
