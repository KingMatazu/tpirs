import { describe, expect, it } from "vitest";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { configSections, describeLogo } from "./configSections.js";

const config = loadFixtureConfig();

describe("configSections", () => {
  it("orders the full set of read-only groups", () => {
    const ids = configSections(config).map((section) => section.id);
    expect(ids).toEqual([
      "identity",
      "locale",
      "branding",
      "asset-types",
      "obligations",
      "providers",
      "channels",
      "cash-rules",
      "payments",
      "feature-flags",
      "field-app",
      "reconciliation",
      "compliance",
    ]);
  });

  it("uses pay-per-use wording that never implies debt", () => {
    const obligations = configSections(config).find((section) => section.id === "obligations");
    const note = obligations?.entries.find((entry) => entry.label === "Pay-per-use note");
    expect(note?.value).toContain("no payment recorded");
    expect(note?.value).toContain("never a debt");
    expect(note?.value.toLowerCase()).not.toContain("unpaid");
  });

  it("formats fee amounts through the tenant currency", () => {
    const feeRules = configSections(config)
      .find((section) => section.id === "obligations")
      ?.subGroups.find((group) => group.title === "Fee rules");
    expect(feeRules?.entries[0]).toMatchObject({
      label: "bike-daily",
    });
    expect(feeRules?.entries[0]?.value).toContain("₦200.00");
  });

  it("exposes secret references for providers, not secret values", () => {
    const providers = configSections(config).find((section) => section.id === "providers");
    const group = providers?.subGroups.find((group) => group.title.includes("PaymentProvider"));
    expect(group?.entries.find((entry) => entry.label === "Secret references")?.value).toContain(
      "tenant/example/paystack-key",
    );
  });
});

describe("describeLogo", () => {
  it("never prints a data URL: the viewer names the format and size instead", () => {
    const png = `data:image/png;base64,${"A".repeat(4096)}`;
    expect(describeLogo(png)).toBe("Uploaded PNG (3 KB)");
  });

  it("names an SVG upload as vector", () => {
    expect(describeLogo("data:image/svg+xml;base64,QUJD")).toBe("Uploaded SVG (1 KB)");
  });

  it("says what the screens fall back to when no logo is set", () => {
    expect(describeLogo("")).toContain("initials");
  });

  it("shows a hosted logo as its address", () => {
    expect(describeLogo("https://cdn.example.gov/logo.svg")).toBe(
      "https://cdn.example.gov/logo.svg",
    );
  });
});
