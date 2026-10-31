import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultScreen } from "./ResultScreen.js";
import type { ScanOutcome } from "../lib/scan.js";

const noop = (): void => undefined;

function renderResult(outcome: ScanOutcome): HTMLElement {
  const { container } = render(
    <ResultScreen
      outcome={outcome}
      smsKeyword="LEVY"
      smsSenderId="ALPHA"
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
      kind: "paid",
      via: "token",
      shortCode: "A000001",
      attributes: { plate_number: "MTZ56AA" },
      businessDate: "2026-06-15",
    });
    expect(screen.getByText(/paid today/i)).toBeTruthy();
    expect(screen.getByText("A000001")).toBeTruthy();
    expect(screen.getByText("MTZ56AA")).toBeTruthy();
    expect(screen.getByText("2026-06-15")).toBeTruthy();
  });

  it("never says a vehicle is unpaid when it is only absent from the cache", () => {
    const container = renderResult({
      kind: "not_in_offline_list",
      via: "token",
      businessDate: "2026-06-15",
    });
    expect(screen.getByText(/not in the offline list/i)).toBeTruthy();
    // The one string that must never appear on this screen.
    expect(container.textContent?.toLowerCase()).not.toContain("unpaid");
    // And the officer is handed a way to check rather than a verdict.
    expect(container.textContent).toContain("LEVY");
    expect(container.textContent).toContain("ALPHA");
  });

  it("treats an unreadable sticker as a scanning problem, not a payment problem", () => {
    const container = renderResult({ kind: "unreadable", via: "token" });
    expect(screen.getByText(/code not recognised/i)).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain("unpaid");
    expect(container.textContent?.toLowerCase()).not.toContain("no payment recorded");
  });

  it("shows the business date the cache was built for", () => {
    renderResult({
      kind: "not_in_offline_list",
      via: "reference",
      businessDate: "2026-06-15",
    });
    expect(screen.getByText("2026-06-15")).toBeTruthy();
  });

  it("omits the SMS instruction when the tenant has not configured one", () => {
    render(
      <ResultScreen
        outcome={{ kind: "not_in_offline_list", via: "token" }}
        smsKeyword={undefined}
        smsSenderId={undefined}
        onScanAgain={noop}
        onBack={noop}
      />,
    );
    expect(screen.getByText(/ask the driver for their receipt/i)).toBeTruthy();
  });
});

describe("ResultScreen accessibility", () => {
  it("announces the result politely so a screen reader reads it once", () => {
    renderResult({ kind: "paid", via: "token" });
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
