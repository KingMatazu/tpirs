import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultScreen } from "./ResultScreen.js";
import type { ScanView } from "../lib/scan-result.js";

const noop = (): void => undefined;

function view(overrides: Partial<ScanView> = {}): ScanView {
  return { verdict: "paid", recorded: "server", corrected: false, ...overrides };
}

function renderResult(
  overrides: Partial<ScanView> = {},
  props: { smsKeyword?: string; smsSenderId?: string } = {
    smsKeyword: "LEVY",
    smsSenderId: "ALPHA",
  },
): HTMLElement {
  const { container } = render(
    <ResultScreen
      view={view(overrides)}
      smsKeyword={props.smsKeyword}
      smsSenderId={props.smsSenderId}
      onScanAgain={noop}
      onBack={noop}
    />,
  );
  if (container.firstElementChild === null) throw new Error("nothing rendered");
  return container;
}

describe("ResultScreen", () => {
  it("confirms a paid vehicle in green with the reference", () => {
    renderResult({
      shortCode: "A000001",
      attributes: { plate_number: "MTZ56AA" },
      businessDate: "2026-06-15",
    });
    expect(screen.getByText(/paid today/i)).toBeTruthy();
    expect(screen.getByText("A000001")).toBeTruthy();
    expect(screen.getByText("MTZ56AA")).toBeTruthy();
    expect(screen.getByText("2026-06-15")).toBeTruthy();
  });

  it("reports a ledger with no payment for the day without calling it a debt", () => {
    const container = renderResult({ verdict: "no_payment_recorded" });
    expect(screen.getByText(/no payment recorded today/i)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("unpaid");
    expect(container.textContent?.toLowerCase()).not.toContain("debt");
  });

  it("never says a vehicle is unpaid when it is only absent from the cache", () => {
    const container = renderResult({ verdict: "not_in_offline_list" });
    expect(screen.getByText(/not in the offline list/i)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("unpaid");
    // The officer is handed a way to check rather than a verdict.
    expect(container.textContent).toContain("LEVY");
    expect(container.textContent).toContain("ALPHA");
  });

  it("asks for a receipt when the ledger could not be read", () => {
    const container = renderResult({ verdict: "unknown" });
    expect(screen.getByText(/could not confirm/i)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("unpaid");
  });

  it("treats an unreadable sticker as a scanning problem, not a payment problem", () => {
    const container = renderResult({ verdict: "unreadable", recorded: "none" });
    expect(screen.getByText(/code not recognised/i)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("unpaid");
  });
});

describe("ResultScreen provenance", () => {
  it("says a queued scan has not reached the ledger yet", () => {
    renderResult({ verdict: "not_in_offline_list", recorded: "queued" });
    expect(screen.getByText(/saved on this phone/i)).toBeTruthy();
  });

  it("does not claim a queued scan was recorded", () => {
    const container = renderResult({ recorded: "queued" });
    expect(container.textContent).not.toContain("Recorded");
  });

  it("shows the ledger's answer when it corrected the cache", () => {
    renderResult({ verdict: "no_payment_recorded", recorded: "server", corrected: true });
    expect(screen.getByText(/the ledger has a newer record/i)).toBeTruthy();
  });

  it("stays quiet when the ledger agrees with the cache", () => {
    const container = renderResult({ verdict: "paid", corrected: false });
    expect(container.textContent).not.toContain("newer record");
  });

  it("omits the SMS instruction when the tenant has not configured one", () => {
    renderResult({ verdict: "not_in_offline_list" }, {});
    expect(screen.getByText(/ask the driver for their receipt/i)).toBeTruthy();
  });
});

describe("ResultScreen accessibility", () => {
  it("announces the result politely so a screen reader reads it once", () => {
    renderResult();
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
