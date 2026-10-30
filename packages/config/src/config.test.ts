import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantConfigFromString } from "./loader.js";
import { validateTenantConfig } from "./validate.js";
import { enabledAnomalyRules } from "./reconciliation.js";
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
    label: "Motorbike"
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
    attributes:
      - key: "plate_number"
        label: "Plate number"
        type: "string"
        required: true
        pattern: "^[A-Z0-9]{5,8}$"
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
  startMenu: "main"
  messages:
    en:
      ussd.main.prompt: "Example Levy. Reply with an option."
      ussd.main.pay: "Pay levy"
      ussd.main.invalid: "Unknown option."
      ussd.common.error: "Something went wrong."
      ussd.session.cancelled: "Cancelled."
      ussd.session.too_many_steps: "Too many steps."
      ussd.rate.limited: "Too many requests."
      ussd.session.busy: "Still processing."
      sms.command.unknown: "Reply with {keyword} and your code."
      ussd.status.paid: "Paid today for {assetRef}."
      ussd.pay.created: "Payment request created for {assetRef}."
      ussd.pay.failed: "Could not start a payment."
      ussd.pay.covered: "Already covered for {assetRef}."
      ussd.asset.unknown: "No vehicle matches {assetRef}."
    ha:
      ussd.main.prompt: "Kuɗin Jiha. Amsa da zaɓi."
      ussd.main.pay: "Biya kuɗin"
      ussd.main.invalid: "Zaɓi mara inganci."
      ussd.common.error: "Wani abu ya samu matsala."
      ussd.session.cancelled: "An soke."
      ussd.session.too_many_steps: "Matakai da yawa."
      ussd.rate.limited: "Buƙatu da yawa."
      ussd.session.busy: "Ana aiki da buƙatarka."
      sms.command.unknown: "Amsa da {keyword} da lambar motarka."
      ussd.status.paid: "An biya yau don {assetRef}."
      ussd.pay.created: "An ƙirƙiri buƙatar biya don {assetRef}."
      ussd.pay.failed: "Ba a iya fara biya ba."
      ussd.pay.covered: "An riga an biya don {assetRef}."
      ussd.asset.unknown: "Babu motar da ta dace da {assetRef}."
  ussd:
    sessionTimeoutSeconds: 120
    maxInputLength: 16
    maxSteps: 8
    rateLimit:
      perMsisdnPerMinute: 10
      perIpPerMinute: 60
  sms:
    maxSendsPerDay: 1000
    maxSendsPerRecipientPerDay: 5
    rateLimit:
      perMsisdnPerMinute: 3
  menus:
    - key: "main"
      promptKey: "ussd.main.prompt"
      invalidKey: "ussd.main.invalid"
      options:
        - key: "1"
          labelKey: "ussd.main.pay"
          next: "pay"
    - key: "pay"
      type: "action"
      action: "pay"
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
  enabled: true
  schedule: "0 2 * * *"
  toleranceMinor: 100
  feeToleranceMinor: 250
  suspenseAgeingDays: 5
  notifyRole: "finance_admin"
  anomalyRules:
    - key: "collector_volume_drop"
      enabled: true
      windowDays: 14
      thresholdPercent: 30
      severity: "warning"
    - key: "suspense_growth"
      enabled: false
      windowDays: 7
      thresholdMinor: 500000
      severity: "warning"
  settlementImport:
    provider: "paystack"
    defaultCurrency: "NGN"
    columns:
      reference: "reference"
      amount: "amount"
      fee: "fee"
      currency: "currency"
      settledAt: "settled_at"
      description: "narration"
    dateFormat: "YYYY-MM-DD HH:mm:ss"
    amountInMinorUnits: true
    decimalSeparator: "."
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
    expect(config.channels.startMenu).toBe("main");
    expect(config.channels.messages?.en?.["ussd.main.prompt"]).toContain("Example Levy");
    expect(config.channels.ussd?.maxSteps).toBe(8);
    expect(config.channels.sms?.maxSendsPerDay).toBe(1000);
    expect(config.reconciliation.feeToleranceMinor).toBe(250);
    expect(config.reconciliation.suspenseAgeingDays).toBe(5);
    expect(config.reconciliation.anomalyRules).toHaveLength(2);
    expect(config.reconciliation.settlementImport?.columns.reference).toBe("reference");
    expect(config.reconciliation.settlementImport?.dateFormat).toBe("YYYY-MM-DD HH:mm:ss");
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

  it("accepts cash intake without a cash receipt template (code default applies)", () => {
    const run = configWith();
    expect(run()).not.toHaveProperty("channels.cashReceiptTemplate", expect.anything());
  });

  it("validates the cash receipt template like the payment receipt template", () => {
    const good = configWith((raw) => {
      (raw.channels as Record<string, unknown>).cashReceiptTemplate =
        "Cash {receiptNo}: {amount} for {assetRef} on {date}.";
    });
    expect(good).not.toThrow();

    const bad = configWith((raw) => {
      (raw.channels as Record<string, unknown>).cashReceiptTemplate = "Cash {cash}.";
    });
    expect(bad).toThrow(/cashReceiptTemplate has unknown placeholder '\{cash\}'/);
  });

  it("rejects a default language not in enabled languages", () => {
    const run = configWith((raw) => {
      (raw.locale as Record<string, unknown>).defaultLanguage = "fr";
    });
    expect(run).toThrow(/defaultLanguage must be in enabledLanguages/);
  });

  function setValidChannels(
    raw: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): void {
    raw.channels = {
      ussdCode: "*1#",
      smsKeyword: "X",
      otpMessageTemplate: "code {code}",
      smsReceiptTemplate: "Receipt {receiptNo}: {amount} for {assetRef} on {date}.",
      startMenu: "main",
      messages: {
        en: {
          "ussd.main.prompt": "Choose an option.",
          "ussd.main.pay": "Pay levy",
          "ussd.main.invalid": "Unknown option.",
          "ussd.code.prompt": "Enter your code.",
          "ussd.code.invalid": "Invalid code.",
          "ussd.common.error": "Something went wrong.",
          "ussd.session.cancelled": "Cancelled.",
          "ussd.session.too_many_steps": "Too many steps.",
          "ussd.rate.limited": "Too many requests.",
          "ussd.session.busy": "Still processing.",
          "sms.command.unknown": "Reply with {keyword} and your code.",
          "ussd.status.paid": "Paid today for {assetRef}.",
          "ussd.pay.created": "Payment request created for {assetRef}.",
          "ussd.pay.failed": "Could not start a payment.",
          "ussd.pay.covered": "Already covered for {assetRef}.",
          "ussd.asset.unknown": "No vehicle matches {assetRef}.",
        },
      },
      menus: [
        {
          key: "main",
          promptKey: "ussd.main.prompt",
          invalidKey: "ussd.main.invalid",
          options: [{ key: "1", labelKey: "ussd.main.pay", next: "pay" }],
        },
        { key: "pay", type: "action", action: "pay" },
      ],
      ...overrides,
    };
  }

  it("accepts a typed menu graph and defaults the start menu", () => {
    const config = configWith((raw) => {
      setValidChannels(raw, { startMenu: undefined });
    })();
    expect(config.channels.startMenu).toBe("main");
    expect(config.channels.menus[1]).toEqual({ type: "action", key: "pay", action: "pay" });
  });

  it("rejects a menu option pointing at an unknown menu", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [
          {
            key: "main",
            promptKey: "ussd.main.prompt",
            options: [{ key: "1", labelKey: "ussd.main.pay", next: "ghost" }],
          },
        ],
      });
    });
    expect(run).toThrow(/references unknown menu 'ghost'/);
  });

  it("rejects a start menu that does not exist", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, { startMenu: "ghost" });
    });
    expect(run).toThrow(/startMenu references unknown menu 'ghost'/);
  });

  it("rejects a start menu when there are no menus", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, { menus: [], messages: {} });
    });
    expect(run).toThrow(/startMenu requires at least one menu/);
  });

  it("rejects duplicate menu keys", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        messages: {},
        menus: [
          { key: "main", type: "action", action: "cancel" },
          { key: "main", type: "action", action: "pay" },
        ],
      });
    });
    expect(run).toThrow(/duplicate menu key 'main'/);
  });

  it("rejects duplicate option keys within a menu", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [
          {
            key: "main",
            promptKey: "ussd.main.prompt",
            options: [
              { key: "1", labelKey: "ussd.main.pay", next: "pay" },
              { key: "1", labelKey: "ussd.main.pay", next: "pay" },
            ],
          },
          { key: "pay", type: "action", action: "pay" },
        ],
      });
    });
    expect(run).toThrow(/duplicate option key '1'/);
  });

  it("rejects an option with both next and action", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [
          {
            key: "main",
            promptKey: "ussd.main.prompt",
            options: [{ key: "1", labelKey: "ussd.main.pay", next: "pay", action: "pay" }],
          },
          { key: "pay", type: "action", action: "pay" },
        ],
      });
    });
    expect(run).toThrow(/exactly one of next or action/);
  });

  it("rejects an option with neither next nor action", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [
          {
            key: "main",
            promptKey: "ussd.main.prompt",
            options: [{ key: "1", labelKey: "ussd.main.pay" }],
          },
        ],
      });
    });
    expect(run).toThrow(/exactly one of next or action/);
  });

  it("rejects a menu without options", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [{ key: "main", promptKey: "ussd.main.prompt", options: [] }],
      });
    });
    expect(run).toThrow(/at least one option/);
  });

  it("rejects a referenced message missing from an enabled language", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        messages: { en: { "ussd.main.prompt": "Choose." } },
      });
    });
    expect(run).toThrow(/message 'ussd.main.pay' is missing for language 'en'/);
  });

  it("rejects a message catalogue for a language that is not enabled", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        messages: { fr: { "ussd.main.prompt": "Choisissez." } },
      });
    });
    expect(run).toThrow(/not in locale.enabledLanguages/);
  });

  it("rejects an invalid input pattern", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [
          {
            key: "main",
            promptKey: "ussd.main.prompt",
            options: [{ key: "1", labelKey: "ussd.main.pay", next: "code" }],
          },
          {
            key: "code",
            type: "input",
            promptKey: "ussd.code.prompt",
            input: { key: "code", pattern: "(", errorKey: "ussd.code.invalid" },
            next: "pay",
          },
          { key: "pay", type: "action", action: "pay" },
        ],
      });
    });
    expect(run).toThrow(/valid regular expression/);
  });

  it("rejects an input node pointing at an unknown menu", () => {
    const run = configWith((raw) => {
      setValidChannels(raw, {
        menus: [
          {
            key: "main",
            type: "input",
            promptKey: "ussd.code.prompt",
            input: { key: "code", errorKey: "ussd.code.invalid" },
            next: "ghost",
          },
        ],
      });
    });
    expect(run).toThrow(/input 'main' references unknown menu 'ghost'/);
  });

  it("defaults USSD and SMS limits when the sections are omitted", () => {
    const config = configWith()();
    expect(config.channels.ussd).toEqual({
      sessionTimeoutSeconds: 180,
      maxInputLength: 32,
      maxSteps: 12,
      rateLimit: { perMsisdnPerMinute: 20, perIpPerMinute: 120 },
    });
    expect(config.channels.sms).toEqual({
      maxSendsPerDay: 5000,
      maxSendsPerRecipientPerDay: 10,
      rateLimit: { perMsisdnPerMinute: 6 },
    });
  });

  it("defaults channel settings but rejects malformed overrides", () => {
    const accepted = configWith((raw) => {
      const channels = raw.channels as Record<string, unknown>;
      channels.ussd = { maxSteps: 5 };
      channels.sms = { maxSendsPerRecipientPerDay: 2 };
    })();
    expect(accepted.channels.ussd?.maxSteps).toBe(5);
    expect(accepted.channels.ussd?.maxInputLength).toBe(32);
    expect(accepted.channels.sms?.maxSendsPerRecipientPerDay).toBe(2);

    const rejected = configWith((raw) => {
      const channels = raw.channels as Record<string, unknown>;
      channels.ussd = { maxSteps: 0 };
    });
    expect(rejected).toThrow(/maxSteps must be >= 1/);
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

describe("reconciliation configuration", () => {
  function rawConfig(): Record<string, unknown> {
    return structuredClone(loadTenantConfigFromString(validYaml)) as unknown as Record<
      string,
      unknown
    >;
  }

  function reconOf(raw: Record<string, unknown>): Record<string, unknown> {
    return raw.reconciliation as Record<string, unknown>;
  }

  function rulesOf(raw: Record<string, unknown>): Record<string, unknown>[] {
    return reconOf(raw).anomalyRules as Record<string, unknown>[];
  }

  function ruleAt(
    rules: readonly Record<string, unknown>[],
    index: number,
  ): Record<string, unknown> {
    const rule = rules[index];
    if (rule === undefined) throw new Error(`no anomaly rule at index ${index}`);
    return rule;
  }

  it("accepts a tenant pausing reconciliation and rejects a non-boolean switch", () => {
    const paused = rawConfig();
    reconOf(paused).enabled = false;
    expect(validateTenantConfig(paused).reconciliation.enabled).toBe(false);

    const broken = rawConfig();
    reconOf(broken).enabled = "yes";
    expect(() => validateTenantConfig(broken)).toThrow(/enabled must be a boolean/);
  });

  it("defaults fee tolerance, suspense ageing and anomaly rules when omitted", () => {
    const raw = rawConfig();
    const recon = reconOf(raw);
    delete recon.feeToleranceMinor;
    delete recon.suspenseAgeingDays;
    delete recon.anomalyRules;
    const config = validateTenantConfig(raw);
    expect(config.reconciliation.enabled).toBe(true);
    expect(config.reconciliation.feeToleranceMinor).toBe(0);
    expect(config.reconciliation.suspenseAgeingDays).toBe(7);
    expect(config.reconciliation.anomalyRules).toEqual([]);
  });

  it("rejects a cron expression the worker could never schedule", () => {
    const raw = rawConfig();
    reconOf(raw).schedule = "0 25 * * *";
    expect(() => validateTenantConfig(raw)).toThrow(/schedule is not a valid cron/);
    expect(() => validateTenantConfig(raw)).toThrow(/hour field/);

    const words = rawConfig();
    reconOf(words).schedule = "every day";
    expect(() => validateTenantConfig(words)).toThrow(/expected 5 fields/);
  });

  it("accepts stepped, ranged and listed cron fields", () => {
    const raw = rawConfig();
    reconOf(raw).schedule = "*/15 2-4 * * 1,3";
    expect(validateTenantConfig(raw).reconciliation.schedule).toBe("*/15 2-4 * * 1,3");
  });

  it("rejects an unknown anomaly rule key", () => {
    const raw = rawConfig();
    ruleAt(rulesOf(raw), 0).key = "asset_goes_silent";
    expect(() => validateTenantConfig(raw)).toThrow(/key must be one of/);
  });

  it("rejects a duplicate anomaly rule", () => {
    const raw = rawConfig();
    const rules = rulesOf(raw);
    ruleAt(rules, 1).key = ruleAt(rules, 0).key;
    expect(() => validateTenantConfig(raw)).toThrow(/repeats/);
  });

  it("requires a threshold on an enabled rule that measures a rate", () => {
    const raw = rawConfig();
    delete ruleAt(rulesOf(raw), 0).thresholdPercent;
    expect(() => validateTenantConfig(raw)).toThrow(/needs thresholdPercent/);
  });

  it("parks a disabled rule without its threshold until it is enabled", () => {
    const raw = rawConfig();
    delete ruleAt(rulesOf(raw), 1).thresholdMinor;
    const config = validateTenantConfig(raw);
    expect(config.reconciliation.anomalyRules[1]?.enabled).toBe(false);

    const enabled = rawConfig();
    const enabledRules = rulesOf(enabled);
    delete ruleAt(enabledRules, 1).thresholdMinor;
    ruleAt(enabledRules, 1).enabled = true;
    expect(() => validateTenantConfig(enabled)).toThrow(/needs thresholdMinor/);
  });

  it("rejects a window shorter than a day and a blocking severity", () => {
    const shortWindow = rawConfig();
    ruleAt(rulesOf(shortWindow), 0).windowDays = 0;
    expect(() => validateTenantConfig(shortWindow)).toThrow(/windowDays must be >= 1/);

    const blocking = rawConfig();
    ruleAt(rulesOf(blocking), 0).severity = "blocking";
    expect(() => validateTenantConfig(blocking)).toThrow(/severity must be one of: warning, info/);
  });

  it("rejects a statement mapping missing a required column", () => {
    const raw = rawConfig();
    const settlement = reconOf(raw).settlementImport as Record<string, unknown>;
    delete (settlement.columns as Record<string, unknown>).reference;
    expect(() => validateTenantConfig(raw)).toThrow(/reference must be a non-empty string/);
  });

  it("rejects an unsupported statement date format or currency", () => {
    const badDate = rawConfig();
    (reconOf(badDate).settlementImport as Record<string, unknown>).dateFormat = "ISO-8601";
    expect(() => validateTenantConfig(badDate)).toThrow(/dateFormat must be one of/);

    const badCurrency = rawConfig();
    (reconOf(badCurrency).settlementImport as Record<string, unknown>).defaultCurrency = "naira";
    expect(() => validateTenantConfig(badCurrency)).toThrow(/ISO 4217/);
  });

  it("exposes only enabled rules in the domain shape", () => {
    const config = loadTenantConfigFromString(validYaml);
    const rules = enabledAnomalyRules(config);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      key: "collector_volume_drop",
      severity: "warning",
      windowDays: 14,
      thresholdPercent: 30,
    });
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

  it("documents the Phase 8 reconciliation keys with safe defaults", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, "../../../tenants/_template/tenant.config.yaml");
    const config = loadTenantConfigFromString(readFileSync(path, "utf8"));

    expect(config.reconciliation.enabled).toBe(true);
    expect(config.reconciliation.feeToleranceMinor).toBe(1000);
    expect(config.reconciliation.suspenseAgeingDays).toBe(7);
    // Every anomaly rule ships disabled until a pilot supplies baselines (D46).
    expect(config.reconciliation.anomalyRules).toHaveLength(5);
    expect(config.reconciliation.anomalyRules.every((rule) => !rule.enabled)).toBe(true);
    expect(enabledAnomalyRules(config)).toEqual([]);

    const statement = config.reconciliation.settlementImport;
    expect(statement?.provider).toBe("mock");
    expect(statement?.columns.settledAt).toBe("settled_at");
    expect(statement?.amountInMinorUnits).toBe(true);
  });
});
