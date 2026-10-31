import { describe, expect, it } from "vitest";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig, TenantProviderBinding } from "@tpirs/config";
import { createMockSecretsProvider } from "@tpirs/secrets-provider-mock";
import { ChannelProviderConfigError, createChannelProviderFactory } from "./index.js";

/** Minimal valid tenant config; only channels and providers vary per test. */
function configWith(providers: readonly TenantProviderBinding[]): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: "Test State",
      slug: "test",
      legalEntity: "Test State Revenue",
      supportContacts: { email: "support@example.test", phone: "+2340000000000" },
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
      appName: "Test",
      logoUrl: "https://example.test/logo.svg",
      colors: { primary: "#000000", secondary: "#111111", accent: "#222222" },
      smsSenderId: "TEST",
      receiptHeader: "Test",
      receiptFooter: "Test",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "T-{id}",
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
      feeRules: [
        { key: "bike-daily", assetTypeKey: "bike", amountMinor: 1, effectiveFrom: "2026-01-01" },
      ],
    },
    providers,
    channels: {
      ussdCode: "*1#",
      smsKeyword: "TEST",
      otpMessageTemplate: "Your code is {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      menus: [],
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 1,
      depositDeadlineHours: 1,
      freezeOnShortfall: true,
    },
    featureFlags: {
      disputes: true,
      prepay: false,
      offlineMode: true,
      anomalyAlerts: true,
    },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    field: {
      offlineGraceHours: 8,
      maxQueueItems: 1000,
      disputeReasons: [{ code: "other", label: "Other" }],
    },
    compliance: { retentionDays: 1, dataResidency: "local", consentTextKey: "consent" },
  });
}

function factory(secrets: Record<string, string> = {}) {
  return createChannelProviderFactory({ secrets: createMockSecretsProvider(secrets) });
}

describe("createChannelProviderFactory", () => {
  it("returns no adapters for a tenant that binds neither channel", async () => {
    const adapters = await factory().forTenant(configWith([]));
    expect(adapters).toEqual({});
  });

  it("builds only the channels the tenant explicitly bound", async () => {
    const adapters = await factory().forTenant(
      configWith([{ port: "SmsProvider", adapter: "mock" }]),
    );
    expect(adapters.sms?.adapter).toBe("mock");
    expect(adapters.ussd).toBeUndefined();
  });

  it("resolves both mock adapters from config", async () => {
    const adapters = await factory().forTenant(
      configWith([
        { port: "SmsProvider", adapter: "mock" },
        { port: "UssdProvider", adapter: "mock" },
      ]),
    );
    expect(adapters.sms?.adapter).toBe("mock");
    expect(adapters.ussd?.adapter).toBe("mock");
    expect(typeof adapters.sms?.provider.send).toBe("function");
    expect(typeof adapters.ussd?.provider.parseCallback).toBe("function");
  });

  it("rejects an adapter the platform does not implement", async () => {
    await expect(
      factory().forTenant(configWith([{ port: "SmsProvider", adapter: "carrier-pigeon" }])),
    ).rejects.toThrow(ChannelProviderConfigError);
  });

  it("resolves referenced secrets and requires adapter credentials", async () => {
    const configured = configWith([
      {
        port: "SmsProvider",
        adapter: "africastalking",
        options: { username: "sandbox" },
        secrets: { apiKey: "secrets/at-key" },
      },
    ]);
    const adapters = await factory({ "secrets/at-key": "test-key" }).forTenant(configured);
    expect(adapters.sms?.adapter).toBe("africastalking");

    await expect(factory().forTenant(configured)).rejects.toThrow(/not found/);

    const withoutUsername = configWith([
      {
        port: "SmsProvider",
        adapter: "africastalking",
        secrets: { apiKey: "secrets/at-key" },
      },
    ]);
    await expect(
      factory({ "secrets/at-key": "test-key" }).forTenant(withoutUsername),
    ).rejects.toThrow(/username/);
  });

  it("rejects a Termii channel the adapter cannot send on", async () => {
    await expect(
      factory({ "secrets/termii-key": "k" }).forTenant(
        configWith([
          {
            port: "SmsProvider",
            adapter: "termii",
            options: { channel: "email" },
            secrets: { apiKey: "secrets/termii-key" },
          },
        ]),
      ),
    ).rejects.toThrow(/unsupported channel/);
  });

  it("caches adapter instances per config object", async () => {
    const providers = createChannelProviderFactory({ secrets: createMockSecretsProvider() });
    const config = configWith([{ port: "UssdProvider", adapter: "mock" }]);
    const first = await providers.forTenant(config);
    const second = await providers.forTenant(config);
    expect(first).toBe(second);
    expect(first.ussd?.provider).toBe(second.ussd?.provider);
  });
});
