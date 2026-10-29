import { describe, expect, it } from "vitest";
import {
  checklistItemLabel,
  checklistSummary,
  defaultReconciliationRange,
  describeExceptionSubject,
  exceptionQueryParams,
  exceptionStatusLabel,
  exceptionStatusTone,
  lastBusinessDays,
  reconciliationQueryParams,
  resolutionBody,
  runStatusLabel,
  runStatusTone,
  severityLabel,
  severityTone,
  signOffBody,
  toleranceLabel,
  type ChecklistItemView,
} from "./reconciliationView.js";

/**
 * The pure rules behind the reconciliation screen. The two that carry money
 * meaning are pinned here: a checklist's failure count (what blocks sign-off)
 * and the query builders, which must never send an empty filter the server
 * would read as an unknown enum value.
 */

const baseCheck: ChecklistItemView = {
  check: "ledger_balances",
  severity: "blocking",
  subjectType: "tenant",
  subjectId: null,
  expectedMinor: "0",
  actualMinor: "0",
  expectedCount: null,
  actualCount: null,
  differenceMinor: "0",
  differenceCount: null,
  withinTolerance: true,
};

describe("run status", () => {
  it("labels every run state without changing the enum", () => {
    expect(runStatusLabel("running")).toBe("Running");
    expect(runStatusLabel("completed")).toBe("Completed");
    expect(runStatusLabel("failed")).toBe("Failed");
    expect(runStatusLabel("signed_off")).toBe("Signed off");
  });

  it("tones a failure red and a signed-off day as the brand accent", () => {
    expect(runStatusTone("running")).toBe("neutral");
    expect(runStatusTone("completed")).toBe("positive");
    expect(runStatusTone("failed")).toBe("danger");
    expect(runStatusTone("signed_off")).toBe("brand");
  });
});

describe("severity and exception status", () => {
  it("tones a blocking finding red and a warning amber", () => {
    expect(severityTone("blocking")).toBe("danger");
    expect(severityTone("warning")).toBe("warning");
    expect(severityTone("info")).toBe("neutral");
    expect(severityLabel("blocking")).toBe("Blocking");
    expect(severityLabel("warning")).toBe("Warning");
    expect(severityLabel("info")).toBe("Info");
  });

  it("explains the exception lifecycle", () => {
    expect(exceptionStatusLabel("open")).toBe("Open");
    expect(exceptionStatusLabel("resolved")).toBe("Resolved");
    expect(exceptionStatusLabel("waived")).toBe("Waived");
    expect(exceptionStatusTone("open")).toBe("warning");
    expect(exceptionStatusTone("resolved")).toBe("positive");
    expect(exceptionStatusTone("waived")).toBe("neutral");
  });
});

describe("checklist labels and summary", () => {
  it("names the checks the service emits and falls back to readable words", () => {
    expect(checklistItemLabel("cash_float")).toBe(
      "Collector float equals intakes minus posted deposits",
    );
    expect(checklistItemLabel("cash_overdue")).toBe("No intake is past the deposit deadline");
    expect(checklistItemLabel("some_new_check")).toBe("Some new check");
  });

  it("explains whether a check was compared at all", () => {
    expect(toleranceLabel(baseCheck)).toBe("Within tolerance");
    expect(toleranceLabel({ ...baseCheck, withinTolerance: false })).toBe("Outside tolerance");
    expect(toleranceLabel({ ...baseCheck, withinTolerance: null })).toBe("Not compared");
  });

  it("counts failures, and blocking failures separately", () => {
    const summary = checklistSummary([
      baseCheck,
      { ...baseCheck, check: "settlement_amounts", withinTolerance: false },
      {
        ...baseCheck,
        check: "duplicate_references",
        withinTolerance: false,
        severity: "warning",
      },
      { ...baseCheck, check: "suspense_ageing", withinTolerance: null },
    ]);
    expect(summary).toEqual({
      total: 4,
      passed: 1,
      failed: 2,
      blockingFailures: 1,
      notCompared: 1,
    });
    expect(checklistSummary([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      blockingFailures: 0,
      notCompared: 0,
    });
  });
});

describe("query builders", () => {
  it("omits an empty status instead of sending an unknown enum value", () => {
    const params = reconciliationQueryParams({ from: "2026-10-21", to: "2026-10-29" });
    expect(params).toEqual({ from: "2026-10-21", to: "2026-10-29" });
    expect("status" in params).toBe(false);
  });

  it("keeps a real run status and trims the bounds", () => {
    expect(
      reconciliationQueryParams({ from: " 2026-10-21 ", to: "2026-10-29", status: "completed" }),
    ).toEqual({ from: "2026-10-21", to: "2026-10-29", status: "completed" });
  });

  it("drops blank exception filters and keeps the chosen ones", () => {
    expect(exceptionQueryParams({ status: "", severity: "" })).toEqual({});
    expect(exceptionQueryParams({ status: "open", severity: "" })).toEqual({ status: "open" });
    expect(exceptionQueryParams({ status: "open", severity: "blocking" })).toEqual({
      status: "open",
      severity: "blocking",
    });
  });
});

describe("describeExceptionSubject", () => {
  it("names the subject type and keeps the identifier verbatim", () => {
    expect(describeExceptionSubject({ subjectType: "collector", subjectId: "collector-1" })).toBe(
      "Collector collector-1",
    );
    expect(describeExceptionSubject({ subjectType: "payment", subjectId: "pay_9" })).toBe(
      "Payment pay_9",
    );
  });

  it("falls back to words for a subject type added later", () => {
    expect(describeExceptionSubject({ subjectType: "statement_row", subjectId: "row-4" })).toBe(
      "Statement row row-4",
    );
    expect(describeExceptionSubject({ subjectType: "tenant", subjectId: "" })).toBe("Tenant");
  });
});

describe("mutation bodies", () => {
  it("sends exactly the note field the contract requires, trimmed", () => {
    expect(signOffBody("  month closed  ")).toEqual({ note: "month closed" });
    expect(resolutionBody(" matched by hand ")).toEqual({ note: "matched by hand" });
  });

  it("leaves a whitespace-only note empty so the page can refuse it", () => {
    expect(signOffBody("   ")).toEqual({ note: "" });
  });
});

describe("business-day ranges", () => {
  it("counts business days backwards, skipping weekends", () => {
    expect(lastBusinessDays(new Date("2026-10-29T10:00:00.000Z"), 7)).toEqual({
      from: "2026-10-21",
      to: "2026-10-29",
    });
    expect(defaultReconciliationRange(new Date("2026-10-29T10:00:00.000Z"))).toEqual({
      from: "2026-10-21",
      to: "2026-10-29",
    });
  });

  it("starts from the previous business day when today is a weekend", () => {
    expect(lastBusinessDays(new Date("2026-11-01T00:00:00.000Z"), 7)).toEqual({
      from: "2026-10-22",
      to: "2026-11-01",
    });
    expect(lastBusinessDays(new Date("2026-10-31T00:00:00.000Z"), 1)).toEqual({
      from: "2026-10-30",
      to: "2026-10-31",
    });
  });
});
