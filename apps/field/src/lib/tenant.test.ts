import { describe, expect, it, beforeEach } from "vitest";
import { applyTheme, readCachedConfig } from "./tenant.js";
import { testConfig } from "../test-support/config.js";

const CONFIG_KEY = "tpirs.field.config";

describe("cached tenant config", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("returns nothing before the first successful sign-in", () => {
    expect(readCachedConfig()).toBeUndefined();
  });

  it("reads a validated config back after a reload", () => {
    globalThis.localStorage.setItem(CONFIG_KEY, JSON.stringify(testConfig()));
    const config = readCachedConfig();
    expect(config?.identity.slug).toBe("alpha-state");
    expect(config?.field.disputeReasons.map((reason) => reason.code)).toEqual([
      "already_paid",
      "other",
    ]);
  });

  it("drops a cache that no longer validates instead of crashing at launch", () => {
    // An older release wrote this; today's schema requires `field`.
    globalThis.localStorage.setItem(CONFIG_KEY, JSON.stringify({ identity: { slug: "old" } }));
    expect(readCachedConfig()).toBeUndefined();
    expect(globalThis.localStorage.getItem(CONFIG_KEY)).toBeNull();
  });
});

describe("applyTheme", () => {
  it("injects the tenant's branding as CSS custom properties", () => {
    applyTheme(testConfig());
    const style = document.getElementById("tpirs-field-theme");
    expect(style?.textContent).toContain("--tpirs-color-primary: #0a5;");
    expect(document.title).toContain("Alpha Levy");
  });
});
