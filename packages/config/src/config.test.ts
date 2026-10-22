import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantConfigFromString } from "./loader.js";
import { validateTenantConfig } from "./validate.js";
import { TenantConfigValidationError } from "./errors.js";
import type { TenantConfig } from "./schema.js";

const validYaml = `
identity:
  name: "Example State"
  slug: "example-state"
  legalEntity: "Example State Revenue Authority"
  supportContacts:
    email: "support@example.state.gov"
    phone: "+2348000000000"
locale:
  defaultLanguage: "en"
  enabledLanguages: ["en", "ha"]
  timezone: "Africa/Lagos"
  currency: "NGN"
  numberFormat: "en-NG"
  dateFormat: "dd/MM/yyyy"
branding:
  appName: "Example Levy"
  logoUrl: "https://cdn.example.state.gov/logo.svg"
  colors:
    primary: "#0a5"
    secondary: "#053"
    accent: "#fc0"
  smsSenderId: "EXLEVY"
  receiptHeader: "Example State Levy"
  receiptFooter: "Thank you"
assetTypes:
  - key: "bike"
    label: "Bicycle"
    attributes:
      - key: "plate_number"
        label: "Plate number"
        type: "string"
        required: true
        pattern: "^[A-Z0-9]{5,8}$"
    qrFormat: "EX-{id}"
    shortCodeFormat: "B{id}"
    stickerSpec: "60x60mm vinyl"
  - key: "tuktuk"
    label: "Tuk-tuk"
    attributes: []
    qrFormat: "EX-K{id}"
    shortCodeFormat: "K{id}"
    stickerSpec: "60x60mm vinyl"
obligations:
  model: "pay_per_use"
  frequency: "daily"
  prepaidAllowed: false
  arrearsPolicy: "none"
  graceDays: 0
  feeRules:
    - key: "bike-daily"
      assetTypeKey: "bike"
      amountMinor: 20000
      effectiveFrom: "2026-01-01"
    - key: "tuktuk-daily"
      assetTypeKey: "tuktuk"
      amountMinor: 30000
      effectiveFrom: "2026-01-01"
providers:
  - port: "PaymentProvider"
    adapter: "mock"
    secrets:
      apiKey: "tenant/example/paystack-key"
    options:
      environment: "sandbox"
channels:
  ussdCode: "*347*9#"
  smsKeyword: "LEVY"
  otpMessageTemplate: "Example: your code is {code}"
  smsReceiptTemplate: "Example receipt {receiptNo}: {amount} paid for {assetRef} on {date}."
  menus:
    - key: "main"
      promptKey: "ussd.main.prompt"
      options:
        - key: "1"
          labelKey: "ussd.main.pay"
          next: "pay"
cashRules:
  enabled: true
  floatCeilingMinor: 5000000
  depositDeadlineHours: 24
  freezeOnShortfall: true
payments:
  underpaymentPolicy: "suspense"
featureFlags:
  disputes: true
  prepay: false
  offlineMode: true
  anomalyAlerts: true
reconciliation:
  schedule: "0 2 * * *"
  toleranceMinor: 100
  notifyRole: "finance_admin"
compliance:
  retentionDays: 2555
  dataResidency: "ng"
  consentTextKey: "consent.default"
`;

describe("loadTenantConfigFromString", () => {
  it("loads a valid configuration", () => {
    const config = loadTenantConfigFromString(validYaml);
    expect(config.identity.slug).toBe("example-state");
    expect(config.locale.currency).toBe("NGN");
    expect(config.assetTypes).toHaveLength(2);
    expect(config.obligations.model).toBe("pay_per_use");
    expect(config.providers[0]?.secrets?.apiKey).toBe("tenant/example/paystack-key");
    expect(config.payments.underpaymentPolicy).toBe("suspense");
    expect(config.channels.smsReceiptTemplate).toContain("{receiptNo}");
  });

  it("rejects invalid YAML", () => {
    expect(() => loadTenantConfigFromString("identity: [unclosed")).toThrow(/Invalid YAML/);
  });
});

describe("validateTenantConfig", () => {
  function configWith(mutate?: (raw: Record<string, unknown>) => void): () => TenantConfig {
    return () => {
      const raw = JSON.parse(
        JSON.stringify({
          identity: {
            name: "X",
            slug: "x",
            legalEntity: "X",
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
            appName: "X",
            logoUrl: "https://x/logo.svg",
            colors: { primary: "#000", secondary: "#111", accent: "#222" },
            smsSenderId: "X",
            receiptHeader: "X",
            receiptFooter: "X",
          },
          assetTypes: [
            {
              key: "bike",
              label: "Bike",
              attributes: [],
              qrFormat: "X-{id}",
              shortCodeFormat: "X{id}",
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
                amountMinor: 1,
                effectiveFrom: "2026-01-01",
              },
            ],
          },
          providers: [],
          channels: {
            ussdCode: "*1#",
            smsKeyword: "X",
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
          featureFlags: {
            disputes: true,
            prepay: false,
            offlineMode: true,
            anomalyAlerts: true,
          },
          reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
          compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
        }),
      ) as Record<string, unknown>;
      mutate?.(raw);
      return validateTenantConfig(raw);
    };
  }

  it("rejects a bad currency code", () => {
    const run = configWith((raw) => {
      (raw.locale as Record<string, unknown>).currency = "naira";
    });
    expect(run).toThrow(TenantConfigValidationError);
    expect(run).toThrow(/currency/);
  });

  it("rejects pay_per_use with accruing arrears", () => {
    const run = configWith((raw) => {
      (raw.obligations as Record<string, unknown>).arrearsPolicy = "accrue";
    });
    expect(run).toThrow(/pay_per_use cannot accrue/);
  });

  it("rejects a fee rule pointing at an unknown asset type", () => {
    const run = configWith((raw) => {
      (raw.obligations as Record<string, unknown>).feeRules = [
        { key: "r", assetTypeKey: "ghost", amountMinor: 1, effectiveFrom: "2026-01-01" },
      ];
    });
    expect(run).toThrow(/unknown assetTypeKey/);
  });

  it("rejects an empty fee rule list", () => {
    const run = configWith((raw) => {
      (raw.obligations as Record<string, unknown>).feeRules = [];
    });
    expect(run).toThrow(/must define at least one rule/);
  });

  it("rejects an asset type with no fee rule and no default rule", () => {
    const run = configWith((raw) => {
      (raw.assetTypes as unknown[]).push({
        key: "tuktuk",
        label: "Tuk-tuk",
        attributes: [],
        qrFormat: "X-K{id}",
        shortCodeFormat: "K{id}",
        stickerSpec: "60x60mm",
      });
    });
    expect(run).toThrow(/no rule for asset type 'tuktuk'/);
  });

  it("accepts a default rule that prices every asset type", () => {
    const run = configWith((raw) => {
      (raw.assetTypes as unknown[]).push({
        key: "tuktuk",
        label: "Tuk-tuk",
        attributes: [],
        qrFormat: "X-K{id}",
        shortCodeFormat: "K{id}",
        stickerSpec: "60x60mm",
      });
      (raw.obligations as Record<string, unknown>).feeRules = [
        { key: "default-daily", amountMinor: 1, effectiveFrom: "2026-01-01" },
      ];
    });
    expect(run).not.toThrow();
  });

  it("rejects overlapping fee rules for the same asset type", () => {
    const run = configWith((raw) => {
      (raw.obligations as Record<string, unknown>).feeRules = [
        {
          key: "old",
          assetTypeKey: "bike",
          amountMinor: 1,
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-06-30",
        },
        { key: "new", assetTypeKey: "bike", amountMinor: 2, effectiveFrom: "2026-06-01" },
      ];
    });
    expect(run).toThrow(/overlap for scope 'bike'/);
  });

  it("accepts non-overlapping effective-dated fee rules", () => {
    const run = configWith((raw) => {
      (raw.obligations as Record<string, unknown>).feeRules = [
        {
          key: "old",
          assetTypeKey: "bike",
          amountMinor: 1,
          effectiveFrom: "2026-01-01",
          effectiveTo: "2026-06-30",
        },
        { key: "new", assetTypeKey: "bike", amountMinor: 2, effectiveFrom: "2026-07-01" },
      ];
    });
    expect(run).not.toThrow();
  });

  it("rejects a fee rule that ends before it starts", () => {
    const run = configWith((raw) => {
      (raw.obligations as Record<string, unknown>).feeRules = [
        {
          key: "backwards",
          assetTypeKey: "bike",
          amountMinor: 1,
          effectiveFrom: "2026-06-30",
          effectiveTo: "2026-01-01",
        },
      ];
    });
    expect(run).toThrow(/ends before it starts/);
  });

  it("defaults the allocation order to oldest_first", () => {
    const config = configWith()();
    expect(config.obligations.allocationOrder).toBe("oldest_first");
  });

  it("defaults the underpayment policy to wallet", () => {
    const config = configWith()();
    expect(config.payments.underpaymentPolicy).toBe("wallet");
  });

  it("accepts an explicit underpayment policy", () => {
    const config = configWith((raw) => {
      raw.payments = { underpaymentPolicy: "suspense" };
    })();
    expect(config.payments.underpaymentPolicy).toBe("suspense");
  });

  it("rejects an unknown underpayment policy", () => {
    const run = configWith((raw) => {
      raw.payments = { underpaymentPolicy: "refund" };
    });
    expect(run).toThrow(/underpaymentPolicy must be one of/);
  });

  it("rejects a receipt template that omits a required placeholder", () => {
    for (const placeholder of ["{amount}", "{assetRef}", "{date}", "{receiptNo}"]) {
      const run = configWith((raw) => {
        const channels = raw.channels as Record<string, unknown>;
        channels.smsReceiptTemplate = String(channels.smsReceiptTemplate).replace(placeholder, "");
      });
      expect(run).toThrow(/smsReceiptTemplate must contain/);
    }
  });

  it("rejects a receipt placeholder the renderer cannot fill", () => {
    const run = configWith((raw) => {
      const channels = raw.channels as Record<string, unknown>;
      channels.smsReceiptTemplate = String(channels.smsReceiptTemplate).replace(
        "{amount}",
        "{amout}",
      );
    });
    expect(run).toThrow(/unknown placeholder '\{amout\}'/);
  });

  it("rejects a default language not in enabled languages", () => {
    const run = configWith((raw) => {
      (raw.locale as Record<string, unknown>).defaultLanguage = "fr";
    });
    expect(run).toThrow(/defaultLanguage must be in enabledLanguages/);
  });

  it("reports every issue at once", () => {
    const run = configWith((raw) => {
      (raw.locale as Record<string, unknown>).currency = "naira";
      (raw.identity as Record<string, unknown>).slug = "Bad Slug";
    });
    try {
      run();
      throw new Error("expected a validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(TenantConfigValidationError);
      if (error instanceof TenantConfigValidationError) {
        expect(error.issues.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("tenants/_template", () => {
  it("validates against the current schema", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "../../../tenants/_template/tenant.config.yaml");
    const config = loadTenantConfigFromString(readFileSync(path, "utf8"));
    expect(config.identity.slug).toBe("template-state");
    expect(config.payments.underpaymentPolicy).toBe("wallet");
  });
});
