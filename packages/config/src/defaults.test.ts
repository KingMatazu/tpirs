import { describe, expect, it } from "vitest";
import { CHANNEL_CATALOGS } from "@tpirs/i18n";
import { CHANNEL_MESSAGE_KEYS } from "./channel-contract.js";
import { PROVISIONABLE_LANGUAGES, defaultTenantConfig } from "./defaults.js";
import type { TenantConfigDefaultsInput } from "./defaults.js";
import { TenantConfigError } from "./errors.js";
import { validateTenantConfig } from "./validate.js";

const answers: TenantConfigDefaultsInput = {
  name: "Katsina State",
  slug: "katsina-state",
  legalEntity: "Katsina State Revenue Authority",
  supportEmail: "support@katsina-state.example.gov",
  supportPhone: "+2348000000000",
  timezone: "Africa/Lagos",
  currency: "NGN",
  numberFormat: "en-NG",
  dateFormat: "dd/MM/yyyy",
  ussdCode: "*347*1#",
  smsSenderId: "KATSINALE",
  bikeFeeMinor: 30000,
  tuktukFeeMinor: 45000,
};

describe("defaultTenantConfig", () => {
  it("produces a configuration the validator accepts", () => {
    const config = defaultTenantConfig(answers);
    expect(() => validateTenantConfig(config)).not.toThrow();
    expect(config.identity.slug).toBe("katsina-state");
    expect(config.locale.currency).toBe("NGN");
  });

  it("prices every asset type it declares", () => {
    const config = defaultTenantConfig(answers);
    const types = config.assetTypes.map((type) => type.key);
    expect(types).toEqual(["bike", "tuktuk"]);
    for (const key of types) {
      expect(config.obligations.feeRules.some((rule) => rule.assetTypeKey === key)).toBe(true);
    }
  });

  it("starts on the per-use model, so an idle day is never a debt", () => {
    const config = defaultTenantConfig(answers);
    expect(config.obligations.model).toBe("pay_per_use");
    expect(config.obligations.arrearsPolicy).toBe("none");
    expect(config.obligations.prepaidAllowed).toBe(false);
  });

  it("dates the fee rules from today unless told otherwise", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(defaultTenantConfig(answers).obligations.feeRules[0]?.effectiveFrom).toBe(today);
    expect(
      defaultTenantConfig({ ...answers, effectiveFrom: "2026-01-01" }).obligations.feeRules[0]
        ?.effectiveFrom,
    ).toBe("2026-01-01");
  });

  it("carries a catalogue for every enabled language", () => {
    const config = defaultTenantConfig({ ...answers, languages: ["en", "fr"] });
    expect(Object.keys(config.channels.messages ?? {}).sort()).toEqual(["en", "fr"]);
    expect(config.channels.messages?.fr?.["ussd.status.none"]).toContain("{assetRef}");
  });

  it("refuses a language this build has no catalogue for", () => {
    let thrown: unknown;
    try {
      defaultTenantConfig({ ...answers, languages: ["en", "ha"] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TenantConfigError);
    expect((thrown as TenantConfigError).path).toBe("languages");
    expect((thrown as TenantConfigError).message).toContain("ha");
  });

  it("refuses a default language that is not enabled", () => {
    expect(() =>
      defaultTenantConfig({ ...answers, languages: ["en"], defaultLanguage: "fr" }),
    ).toThrow(TenantConfigError);
  });

  it("leaves zones to the tenant: it declares none", () => {
    // Zones are provisioning input, not config: a tenant with none is valid.
    expect(defaultTenantConfig(answers)).not.toHaveProperty("zones");
  });
});

describe("shipped catalogues", () => {
  it("answer every key the channel runtime can reach, in every language", () => {
    const missing: string[] = [];
    for (const language of PROVISIONABLE_LANGUAGES) {
      const catalogue = CHANNEL_CATALOGS[language] ?? {};
      for (const key of Object.values(CHANNEL_MESSAGE_KEYS)) {
        if (catalogue[key] === undefined) missing.push(`${language}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("contain no placeholders the menu prompt cannot fill", () => {
    // `ussd.main.prompt` is rendered without variables, so an `{appName}`
    // placeholder would throw `missing_variable` at a driver's first dial.
    const offender = PROVISIONABLE_LANGUAGES.flatMap((language) =>
      Object.entries(CHANNEL_CATALOGS[language] ?? {})
        .filter(([, text]) => text.includes("{appName}"))
        .map(([key]) => `${language}:${key}`),
    );
    expect(offender).toEqual([]);
  });
});
