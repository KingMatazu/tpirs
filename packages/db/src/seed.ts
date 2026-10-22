import { createDb, type AnyDb } from "./connection.js";
import { withSystem } from "./tenant-scope.js";
import { repositories } from "./repositories/index.js";
import { SYSTEM_ROLES } from "@tpirs/domain";
import { hashPassword } from "@tpirs/crypto";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";

export type SeedFn = (db: AnyDb) => Promise<void>;

interface FakeTenant {
  readonly slug: string;
  readonly name: string;
  readonly legalEntity: string;
  readonly config: TenantConfig;
  readonly zones: readonly string[];
  readonly users: readonly {
    readonly username: string;
    readonly displayName: string;
    readonly password: string;
    readonly roleKeys: readonly string[];
  }[];
}

/** Shared shape for the two fake tenants, differing only by configuration. */
function baseConfig(overrides: {
  name: string;
  slug: string;
  legalEntity: string;
  language: string;
  languages: readonly string[];
  timezone: string;
  currency: string;
  numberFormat: string;
  dateFormat: string;
  appName: string;
  smsSenderId: string;
  ussdCode: string;
  bikeFee: number;
  tuktukFee: number;
  dataResidency: string;
  underpaymentPolicy: TenantConfig["payments"]["underpaymentPolicy"];
}): TenantConfig {
  return {
    identity: {
      name: overrides.name,
      slug: overrides.slug,
      legalEntity: overrides.legalEntity,
      supportContacts: {
        email: `support@${overrides.slug}.example.gov`,
        phone: "+000000000000",
      },
    },
    locale: {
      defaultLanguage: overrides.language,
      enabledLanguages: overrides.languages,
      timezone: overrides.timezone,
      currency: overrides.currency,
      numberFormat: overrides.numberFormat,
      dateFormat: overrides.dateFormat,
    },
    branding: {
      appName: overrides.appName,
      logoUrl: `https://cdn.${overrides.slug}.example.gov/logo.svg`,
      colors: { primary: "#0a5a4a", secondary: "#053b33", accent: "#f2c200" },
      smsSenderId: overrides.smsSenderId,
      receiptHeader: overrides.name,
      receiptFooter: "Thank you",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bicycle",
        attributes: [
          {
            key: "plate_number",
            label: "Plate number",
            type: "string",
            required: true,
            pattern: "^[A-Z0-9]{5,8}$",
          },
        ],
        qrFormat: "QR-{id}",
        shortCodeFormat: "B{id}",
        stickerSpec: "60x60mm vinyl",
      },
      {
        key: "tuktuk",
        label: "Tuk-tuk",
        attributes: [],
        qrFormat: "QR-K{id}",
        shortCodeFormat: "K{id}",
        stickerSpec: "60x60mm vinyl",
      },
    ],
    obligations: {
      model: "pay_per_use",
      frequency: "daily",
      prepaidAllowed: false,
      arrearsPolicy: "none",
      allocationOrder: "oldest_first",
      graceDays: 0,
      feeRules: [
        {
          key: "bike-daily",
          assetTypeKey: "bike",
          amountMinor: overrides.bikeFee,
          effectiveFrom: "2026-01-01",
        },
        {
          key: "tuktuk-daily",
          assetTypeKey: "tuktuk",
          amountMinor: overrides.tuktukFee,
          effectiveFrom: "2026-01-01",
        },
      ],
    },
    providers: [
      { port: "PaymentProvider", adapter: "mock" },
      { port: "SmsProvider", adapter: "mock" },
      { port: "UssdProvider", adapter: "mock" },
    ],
    channels: {
      ussdCode: overrides.ussdCode,
      smsKeyword: "LEVY",
      otpMessageTemplate: `${overrides.appName}: your verification code is {code}.`,
      smsReceiptTemplate: `${overrides.appName} receipt {receiptNo}: {amount} paid for {assetRef} on {date}.`,
      menus: [
        {
          key: "main",
          promptKey: "ussd.main.prompt",
          options: [{ key: "1", labelKey: "ussd.main.pay", next: "pay" }],
        },
      ],
    },
    cashRules: {
      enabled: true,
      floatCeilingMinor: 5_000_000,
      depositDeadlineHours: 24,
      freezeOnShortfall: true,
    },
    payments: { underpaymentPolicy: overrides.underpaymentPolicy },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 100, notifyRole: "finance_admin" },
    compliance: {
      retentionDays: 2555,
      dataResidency: overrides.dataResidency,
      consentTextKey: "consent.default",
    },
  };
}

const FAKE_TENANTS: readonly FakeTenant[] = [
  {
    slug: "alpha-state",
    name: "Alpha State",
    legalEntity: "Alpha State Revenue Authority",
    config: baseConfig({
      name: "Alpha State",
      slug: "alpha-state",
      legalEntity: "Alpha State Revenue Authority",
      language: "en",
      languages: ["en"],
      timezone: "Africa/Lagos",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
      appName: "Alpha Levy",
      smsSenderId: "ALPHALEVY",
      ussdCode: "*347*1#",
      bikeFee: 20000,
      tuktukFee: 30000,
      dataResidency: "alpha",
      underpaymentPolicy: "wallet",
    }),
    zones: ["Central", "Harbour"],
    users: [
      {
        username: "alpha.admin",
        displayName: "Alpha Admin",
        password: "alpha-admin-password",
        roleKeys: ["system_admin"],
      },
      {
        username: "alpha.officer",
        displayName: "Alpha Officer",
        password: "alpha-officer-password",
        roleKeys: ["officer"],
      },
      {
        username: "alpha.collector",
        displayName: "Alpha Collector",
        password: "alpha-collector-password",
        roleKeys: ["collector"],
      },
    ],
  },
  {
    slug: "beta-state",
    name: "Beta State",
    legalEntity: "Beta State Transport Levy Board",
    config: baseConfig({
      name: "Beta State",
      slug: "beta-state",
      legalEntity: "Beta State Transport Levy Board",
      language: "fr",
      languages: ["fr", "en"],
      timezone: "Africa/Accra",
      currency: "GHS",
      numberFormat: "en-GH",
      dateFormat: "yyyy-MM-dd",
      appName: "Beta Levy",
      smsSenderId: "BETALEVY",
      ussdCode: "*124#",
      bikeFee: 500,
      tuktukFee: 800,
      dataResidency: "beta",
      underpaymentPolicy: "suspense",
    }),
    zones: ["North", "South"],
    users: [
      {
        username: "beta.admin",
        displayName: "Beta Admin",
        password: "beta-admin-password",
        roleKeys: ["system_admin"],
      },
      {
        username: "beta.finance",
        displayName: "Beta Finance",
        password: "beta-finance-password",
        roleKeys: ["finance_admin"],
      },
      {
        username: "beta.officer",
        displayName: "Beta Officer",
        password: "beta-officer-password",
        roleKeys: ["officer"],
      },
    ],
  },
];

/**
 * Seeds the two fake tenants side by side. No code branches on tenant identity:
 * everything that differs lives in the validated config, and roles come from the
 * shared system-role definitions.
 */
export const seed: SeedFn = async (db) => {
  for (const fake of FAKE_TENANTS) {
    const config = validateTenantConfig(fake.config);
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const existing = await repos.tenants.findBySlug(config.identity.slug);
      const tenant =
        existing ??
        (await repos.tenants.create({
          slug: config.identity.slug,
          name: config.identity.name,
          legalEntity: config.identity.legalEntity,
          config,
        }));

      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const existingRole = await repos.roles.findByKey(role.key);
        const created =
          existingRole ??
          (await repos.roles.create({
            tenantId: tenant.id,
            key: role.key,
            name: role.name,
            permissions: role.permissions,
          }));
        roleIds.set(role.key, created.id);
      }

      for (const zoneName of fake.zones) {
        const zones = await repos.zones.list();
        if (!zones.some((z) => z.name === zoneName)) {
          await repos.zones.create({ tenantId: tenant.id, parentZoneId: null, name: zoneName });
        }
      }

      for (const user of fake.users) {
        if ((await repos.users.findByUsername(user.username)) !== undefined) continue;
        const created = await repos.users.create({
          tenantId: tenant.id,
          username: user.username,
          displayName: user.displayName,
          passwordHash: await hashPassword(user.password),
          totpSecret: null,
        });
        for (const roleKey of user.roleKeys) {
          const roleId = roleIds.get(roleKey);
          if (roleId !== undefined) {
            await repos.roles.assignToUser({ tenantId: tenant.id, userId: created.id, roleId });
          }
        }
      }
    });
  }
};

export async function runSeed(connectionString: string): Promise<void> {
  const db = createDb({ connectionString });
  try {
    await seed(db);
  } finally {
    await db.destroy();
  }
}
