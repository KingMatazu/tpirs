import { describe, expect, it } from "vitest";
import { createAssetSchemaRegistryConformanceSuite } from "@tpirs/contracts";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { tenantId } from "@tpirs/domain";
import { PortError } from "@tpirs/ports";
import { createConfigAssetSchemaRegistry } from "./index.js";

function configFor(
  slug: string,
  extraAttributes: TenantConfig["assetTypes"][number]["attributes"] = [],
): TenantConfig {
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
        attributes: [
          { key: "plate_number", label: "Plate number", type: "string", required: true },
          ...extraAttributes,
        ],
        qrFormat: "QR-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: 20000,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [],
    channels: {
      ussdCode: "*1#",
      smsKeyword: "LEVY",
      otpMessageTemplate: "code {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
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

const conformanceConfig = configFor("conformance-tenant");

createAssetSchemaRegistryConformanceSuite({ describe, it, expect }, () => ({
  port: createConfigAssetSchemaRegistry({
    loadConfig: (id) =>
      Promise.resolve(id === "conformance-tenant" ? conformanceConfig : undefined),
  }),
}));

describe("createConfigAssetSchemaRegistry", () => {
  it("throws not_found when the tenant has no configuration", async () => {
    const registry = createConfigAssetSchemaRegistry({
      loadConfig: () => Promise.resolve(undefined),
    });
    await expect(registry.listTypes(tenantId("missing-tenant"))).rejects.toThrow(PortError);
  });

  it("enforces patterns, dates, and enums declared in config", async () => {
    const config = configFor("alpha-state", [
      { key: "plate", label: "Plate", type: "string", required: true, pattern: "^[A-Z0-9]{5}$" },
      { key: "issued_on", label: "Issued", type: "date", required: false },
      { key: "colour", label: "Colour", type: "enum", required: false, options: ["red", "blue"] },
    ]);
    const registry = createConfigAssetSchemaRegistry({
      loadConfig: (id) => Promise.resolve(id === "alpha-state" ? config : undefined),
    });
    const tid = tenantId("alpha-state");

    const badPattern = await registry.validateAttributes(tid, "bike", {
      plate_number: "OK12345",
      plate: "lower",
    });
    expect(badPattern.ok).toBe(false);
    expect(badPattern.errors.some((e) => e.attribute === "plate")).toBe(true);

    const badDate = await registry.validateAttributes(tid, "bike", {
      plate_number: "OK12345",
      issued_on: "2026-13-40",
    });
    expect(badDate.errors.some((e) => e.attribute === "issued_on")).toBe(true);

    const badEnum = await registry.validateAttributes(tid, "bike", {
      plate_number: "OK12345",
      colour: "green",
    });
    expect(badEnum.errors.some((e) => e.attribute === "colour")).toBe(true);

    const good = await registry.validateAttributes(tid, "bike", {
      plate_number: "OK12345",
      plate: "AB123",
      issued_on: "2026-01-01",
      colour: "red",
    });
    expect(good.ok).toBe(true);
  });
});
