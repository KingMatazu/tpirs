import { describe, expect, it } from "vitest";
import { createFeeEngineConformanceSuite } from "@tpirs/contracts";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { assetTypeId, businessDate, tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import { createConfigFeeEngine } from "./index.js";

function configFor(slug: string, feeRules: TenantConfig["obligations"]["feeRules"]): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: "Conformance",
      slug,
      legalEntity: "Conformance Revenue",
      supportContacts: { email: "a@b.co", phone: "+1" },
    },
    locale: {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
      timezone: "Africa/Lagos",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: "Conformance",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "CONF",
      receiptHeader: "Conformance",
      receiptFooter: "Thanks",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "QR-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm",
      },
      {
        key: "tuktuk",
        label: "Tuk-tuk",
        attributes: [],
        qrFormat: "QR-{id}",
        shortCodeFormat: "T{id}",
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      graceDays: 0,
      feeRules,
    },
    providers: [],
    channels: { ussdCode: "*1#", smsKeyword: "LEVY", otpMessageTemplate: "code {code}", menus: [] },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 1,
      depositDeadlineHours: 1,
      freezeOnShortfall: true,
    },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
}

const conformanceConfig = configFor("conformance-tenant", [
  { key: "bike-daily", assetTypeKey: "bike", amountMinor: 20000, effectiveFrom: "2026-01-01" },
  { key: "tuktuk-daily", assetTypeKey: "tuktuk", amountMinor: 30000, effectiveFrom: "2026-01-01" },
]);

createFeeEngineConformanceSuite({ describe, it, expect }, () => ({
  port: createConfigFeeEngine({
    loadConfig: (id) =>
      Promise.resolve(id === "conformance-tenant" ? conformanceConfig : undefined),
  }),
}));

describe("createConfigFeeEngine", () => {
  it("throws not_found when the tenant has no configuration", async () => {
    const engine = createConfigFeeEngine({ loadConfig: () => Promise.resolve(undefined) });
    await expect(
      engine.resolveFee({
        tenantId: tenantId("missing-tenant"),
        assetType: assetTypeId("bike"),
        businessDate: businessDate("2026-01-01"),
      }),
    ).rejects.toThrow(PortError);
  });

  it("resolves the rule that is effective on the business date", async () => {
    const config = configFor("alpha-state", [
      {
        key: "bike-old",
        assetTypeKey: "bike",
        amountMinor: 10000,
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-06-30",
      },
      { key: "bike-new", assetTypeKey: "bike", amountMinor: 15000, effectiveFrom: "2026-07-01" },
      {
        key: "tuktuk-daily",
        assetTypeKey: "tuktuk",
        amountMinor: 30000,
        effectiveFrom: "2026-01-01",
      },
    ]);
    const engine = createConfigFeeEngine({
      loadConfig: (id) => Promise.resolve(id === "alpha-state" ? config : undefined),
    });
    const tid = tenantId("alpha-state");

    const before = await engine.resolveFee({
      tenantId: tid,
      assetType: assetTypeId("bike"),
      businessDate: businessDate("2026-05-01"),
    });
    expect(before.ruleId).toBe("bike-old");
    expect(before.amountMinor).toBe(10000);

    const after = await engine.resolveFee({
      tenantId: tid,
      assetType: assetTypeId("bike"),
      businessDate: businessDate("2026-07-01"),
    });
    expect(after.ruleId).toBe("bike-new");
    expect(after.amountMinor).toBe(15000);
  });

  it("takes the currency from the tenant locale", async () => {
    const engine = createConfigFeeEngine({
      loadConfig: () => Promise.resolve(conformanceConfig),
    });
    const fee = await engine.resolveFee({
      tenantId: tenantId("conformance-tenant"),
      assetType: assetTypeId("bike"),
      businessDate: businessDate("2026-01-01"),
    });
    expect(fee.currency).toBe("NGN");
  });

  it("falls back to a default rule for an asset type with no rule of its own", async () => {
    const config = configFor("beta-state", [
      { key: "default-daily", amountMinor: 12000, effectiveFrom: "2026-01-01" },
    ]);
    const engine = createConfigFeeEngine({
      loadConfig: (id) => Promise.resolve(id === "beta-state" ? config : undefined),
    });
    const fee = await engine.resolveFee({
      tenantId: tenantId("beta-state"),
      assetType: assetTypeId("tuktuk"),
      businessDate: businessDate("2026-01-01"),
    });
    expect(fee.ruleId).toBe("default-daily");
    expect(fee.amountMinor).toBe(12000);
  });

  it("rejects an unknown asset type when no default rule applies", async () => {
    const engine = createConfigFeeEngine({
      loadConfig: () => Promise.resolve(conformanceConfig),
    });
    await expect(
      engine.resolveFee({
        tenantId: tenantId("conformance-tenant"),
        assetType: assetTypeId("no-such-type"),
        businessDate: businessDate("2026-01-01"),
      }),
    ).rejects.toThrow(PortError);
  });
});
