import { describe, expect, it } from "vitest";
import { loadFixtureConfig } from "../test-support/tenant.js";
import { dashboardLanguages, dashboardTranslator } from "./uiCopy.js";
import type { TenantConfig } from "@tpirs/config";

const fixture = loadFixtureConfig();

function withLocale(overrides: Partial<TenantConfig["locale"]>): TenantConfig {
  return { ...fixture, locale: { ...fixture.locale, ...overrides } };
}

describe("dashboard languages", () => {
  it("offers only languages the product ships", () => {
    // The fixture enables Hausa, which has no dashboard catalogue yet.
    const config = withLocale({ enabledLanguages: ["en", "ha"], defaultLanguage: "en" });
    expect(dashboardLanguages(config)).toEqual({ languages: ["en"], defaultLanguage: "en" });
  });

  it("keeps a tenant default that has a catalogue", () => {
    const config = withLocale({ enabledLanguages: ["fr", "en"], defaultLanguage: "fr" });
    expect(dashboardLanguages(config)).toEqual({ languages: ["fr", "en"], defaultLanguage: "fr" });
  });

  it("falls back to English when the configured default has no catalogue", () => {
    const config = withLocale({ enabledLanguages: ["ha"], defaultLanguage: "ha" });
    expect(dashboardLanguages(config)).toEqual({ languages: ["en"], defaultLanguage: "en" });
  });
});

describe("dashboard translator", () => {
  it("translates navigation in the tenant default language", () => {
    const config = withLocale({ enabledLanguages: ["fr", "en"], defaultLanguage: "fr" });
    const copy = dashboardTranslator(config, undefined);
    expect(copy.language).toBe("fr");
    expect(copy.t("nav.registry")).toBe("Registre");
    expect(copy.t("shell.signOut")).toBe("Se déconnecter");
  });

  it("honours an enabled selection and ignores a disabled one", () => {
    const config = withLocale({ enabledLanguages: ["fr", "en"], defaultLanguage: "fr" });
    expect(dashboardTranslator(config, "en").t("nav.registry")).toBe("Registry");
    // Hausa is not shipped, so the pick falls back to the tenant default.
    expect(dashboardTranslator(config, "ha").language).toBe("fr");
  });
});
