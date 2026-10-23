import { describe, expect, it } from "vitest";
import { MessageCatalogError, createTranslator } from "./index.js";

const catalogs = {
  en: {
    "ussd.main.prompt": "Welcome to Example Levy. {name}",
    "ussd.status.paid": "Paid today for {assetRef}.",
    "sms.receipt": "Receipt {receiptNo}: {amount} on {date}.",
  },
  fr: {
    "ussd.main.prompt": "Bienvenue. {name}",
    "ussd.status.paid": "Payé aujourd'hui pour {assetRef}.",
  },
} as const;

describe("createTranslator", () => {
  it("translates and interpolates the requested language", () => {
    const translator = createTranslator({
      catalogs,
      defaultLanguage: "en",
      enabledLanguages: ["en", "fr"],
    });

    expect(translator.t("ussd.status.paid", { assetRef: "BK-123" }, "fr")).toBe(
      "Payé aujourd'hui pour BK-123.",
    );
  });

  it("falls back to the default language for a missing key", () => {
    const translator = createTranslator({
      catalogs,
      defaultLanguage: "en",
      enabledLanguages: ["en", "fr"],
    });

    expect(
      translator.t("sms.receipt", { receiptNo: "R1", amount: "500", date: "2026-10-23" }, "fr"),
    ).toBe("Receipt R1: 500 on 2026-10-23.");
  });

  it("falls back to the default language for an unknown language", () => {
    const translator = createTranslator({
      catalogs,
      defaultLanguage: "en",
      enabledLanguages: ["en", "fr"],
    });

    expect(translator.t("ussd.main.prompt", { name: "Alpha" }, "de")).toBe(
      "Welcome to Example Levy. Alpha",
    );
  });

  it("accepts numbers as interpolation variables", () => {
    const translator = createTranslator({
      catalogs: { en: { "fee.due": "Pay {amount} by {day}." } },
      defaultLanguage: "en",
    });

    expect(translator.t("fee.due", { amount: 500, day: 2 })).toBe("Pay 500 by 2.");
  });

  it("throws for a missing key in every catalogue", () => {
    const translator = createTranslator({
      catalogs,
      defaultLanguage: "en",
      enabledLanguages: ["en", "fr"],
    });

    expect(() => translator.t("ussd.missing")).toThrow(MessageCatalogError);
    try {
      translator.t("ussd.missing");
    } catch (error) {
      expect(error).toBeInstanceOf(MessageCatalogError);
      expect((error as MessageCatalogError).code).toBe("missing_key");
    }
  });

  it("throws when an interpolation variable is missing", () => {
    const translator = createTranslator({
      catalogs,
      defaultLanguage: "en",
      enabledLanguages: ["en", "fr"],
    });

    expect(() => translator.t("ussd.status.paid")).toThrow(MessageCatalogError);
    try {
      translator.t("ussd.status.paid");
    } catch (error) {
      expect((error as MessageCatalogError).code).toBe("missing_variable");
    }
  });

  it("reports whether a key exists in the requested or default language", () => {
    const translator = createTranslator({
      catalogs,
      defaultLanguage: "en",
      enabledLanguages: ["en", "fr"],
    });

    expect(translator.has("sms.receipt", "fr")).toBe(true);
    expect(translator.has("ussd.missing", "fr")).toBe(false);
  });

  it("rejects a default language that is not enabled", () => {
    expect(() =>
      createTranslator({
        catalogs,
        defaultLanguage: "en",
        enabledLanguages: ["fr"],
      }),
    ).toThrow(MessageCatalogError);
  });

  it("rejects an empty enabled language list", () => {
    expect(() =>
      createTranslator({
        catalogs,
        defaultLanguage: "en",
        enabledLanguages: [],
      }),
    ).toThrow(MessageCatalogError);
  });

  it("rejects a non-string message value", () => {
    expect(() =>
      createTranslator({
        catalogs: { en: { broken: 42 as unknown as string } },
        defaultLanguage: "en",
      }),
    ).toThrow(MessageCatalogError);
  });

  it("rejects a missing default catalogue", () => {
    expect(() =>
      createTranslator({
        catalogs: { fr: { key: "valeur" } },
        defaultLanguage: "en",
        enabledLanguages: ["en", "fr"],
      }),
    ).toThrow(MessageCatalogError);
  });
});
