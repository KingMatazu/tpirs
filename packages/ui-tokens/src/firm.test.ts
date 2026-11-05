import { describe, expect, it } from "vitest";
import { FIRM_ATTRIBUTION, FIRM_LOGO, FIRM_NAME, firmAttributionHref } from "./firm.js";

describe("firm attribution", () => {
  it("names the firm in the footer line", () => {
    expect(FIRM_ATTRIBUTION.label).toBe("Powered by Star Galaxy Innovation and Technology Ltd");
    expect(FIRM_ATTRIBUTION.label).toContain(FIRM_NAME);
  });

  it("has no link until a website exists, so the footer is never a dead link", () => {
    expect(FIRM_ATTRIBUTION.href).toBe("");
    expect(firmAttributionHref()).toBeUndefined();
  });

  it("ships a logo the pre-sign-in screens can render without a network request", () => {
    expect(FIRM_LOGO.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(FIRM_LOGO)).toContain("STAR GALAXY");
  });
});
