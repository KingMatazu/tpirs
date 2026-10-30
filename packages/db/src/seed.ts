import { createDb, type AnyDb } from "./connection.js";
import { withSystem } from "./tenant-scope.js";
import { repositories } from "./repositories/index.js";
import { SYSTEM_ROLES } from "@tpirs/domain";
import { hashPassword } from "@tpirs/crypto";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { seedCollectorCashDay, type CashDemoSeed } from "./seed-cash.js";

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
  /** One settled cash day for the demo collector, when the tenant wants one. */
  readonly cashDemo?: CashDemoSeed;
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
  feeToleranceMinor: number;
  suspenseAgeingDays: number;
}): TenantConfig {
  const catalogs: Record<string, Record<string, string>> = {
    en: {
      "ussd.main.prompt": `${overrides.appName}. Reply with an option.`,
      "ussd.main.pay": "Pay today's levy",
      "ussd.main.status": "Check payment status",
      "ussd.main.invalid": "Unknown option. Try again.",
      "ussd.common.cancel": "Cancel",
      "ussd.common.confirm": "Confirm",
      "ussd.pay.enter": "Enter your vehicle plate or sticker code.",
      "ussd.pay.invalid": "That code is not valid. Try again.",
      "ussd.pay.confirm": "Pay today's levy for {assetRef}?",
      "ussd.status.enter": "Enter your vehicle plate or sticker code.",
      "ussd.status.invalid": "That code is not valid. Try again.",
      "ussd.status.paid": "Paid today for {assetRef}.",
      "ussd.status.none": "No payment recorded today for {assetRef}.",
      "ussd.pay.created": "Payment request created for {assetRef}.",
      "ussd.pay.failed": "We could not start a payment. Try again later.",
      "ussd.pay.balance": "Paid today from your balance for {assetRef}.",
      "ussd.pay.covered": "Your balance already covers today's levy for {assetRef}.",
      "ussd.pay.insufficient": "Your balance is short by {amount} for {assetRef}.",
      "ussd.asset.unknown": "No vehicle matches {assetRef}.",
      "ussd.common.error": "Something went wrong. Try again later.",
      "ussd.session.cancelled": "Cancelled. Dial back whenever you need to pay.",
      "ussd.session.too_many_steps": "Too many steps. Please start again.",
      "ussd.rate.limited": "Too many requests. Please wait a minute and try again.",
      "ussd.session.busy": "Your request is still being processed. Please wait.",
      "sms.command.unknown": "Reply with {keyword} followed by your plate or sticker code.",
    },
    fr: {
      "ussd.main.prompt": `${overrides.appName}. Choisissez une option.`,
      "ussd.main.pay": "Payer la taxe du jour",
      "ussd.main.status": "Vérifier le paiement",
      "ussd.main.invalid": "Option inconnue. Réessayez.",
      "ussd.common.cancel": "Annuler",
      "ussd.common.confirm": "Confirmer",
      "ussd.pay.enter": "Entrez la plaque ou le code du véhicule.",
      "ussd.pay.invalid": "Code invalide. Réessayez.",
      "ussd.pay.confirm": "Payer la taxe du jour pour {assetRef} ?",
      "ussd.status.enter": "Entrez la plaque ou le code du véhicule.",
      "ussd.status.invalid": "Code invalide. Réessayez.",
      "ussd.status.paid": "Payé aujourd'hui pour {assetRef}.",
      "ussd.status.none": "Aucun paiement enregistré aujourd'hui pour {assetRef}.",
      "ussd.pay.created": "Demande de paiement créée pour {assetRef}.",
      "ussd.pay.failed": "Impossible de démarrer le paiement. Réessayez plus tard.",
      "ussd.pay.balance": "Payé aujourd'hui depuis votre solde pour {assetRef}.",
      "ussd.pay.covered": "Votre solde couvre déjà la taxe du jour pour {assetRef}.",
      "ussd.pay.insufficient": "Votre solde est insuffisant de {amount} pour {assetRef}.",
      "ussd.asset.unknown": "Aucun véhicule ne correspond à {assetRef}.",
      "ussd.common.error": "Une erreur est survenue. Réessayez plus tard.",
      "ussd.session.cancelled": "Annulé. Recomposez le code quand vous voulez payer.",
      "ussd.session.too_many_steps": "Trop d'étapes. Veuillez recommencer.",
      "ussd.rate.limited": "Trop de demandes. Patientez une minute puis réessayez.",
      "ussd.session.busy": "Votre demande est encore en cours. Veuillez patienter.",
      "sms.command.unknown": "Répondez avec {keyword} suivi de votre plaque ou code.",
    },
  };
  const messages: Record<string, Record<string, string>> = {};
  for (const language of overrides.languages) {
    const catalog = catalogs[language];
    if (catalog !== undefined) messages[language] = catalog;
  }

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
        label: "Motorbike",
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
        attributes: [
          {
            key: "plate_number",
            label: "Plate number",
            type: "string",
            required: true,
            pattern: "^[A-Z0-9]{5,8}$",
          },
        ],
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
      startMenu: "main",
      messages,
      menus: [
        {
          type: "menu",
          key: "main",
          promptKey: "ussd.main.prompt",
          invalidKey: "ussd.main.invalid",
          options: [
            { key: "1", labelKey: "ussd.main.pay", next: "pay.enter" },
            { key: "2", labelKey: "ussd.main.status", next: "status.enter" },
            { key: "0", labelKey: "ussd.common.cancel", action: "cancel" },
          ],
        },
        {
          type: "input",
          key: "pay.enter",
          promptKey: "ussd.pay.enter",
          input: {
            key: "assetRef",
            pattern: "^[A-Z0-9]{5,8}$",
            errorKey: "ussd.pay.invalid",
          },
          next: "pay.confirm",
        },
        {
          type: "menu",
          key: "pay.confirm",
          promptKey: "ussd.pay.confirm",
          options: [
            { key: "1", labelKey: "ussd.common.confirm", action: "pay" },
            { key: "2", labelKey: "ussd.common.cancel", action: "cancel" },
          ],
        },
        {
          type: "input",
          key: "status.enter",
          promptKey: "ussd.status.enter",
          input: {
            key: "assetRef",
            pattern: "^[A-Z0-9]{5,8}$",
            errorKey: "ussd.status.invalid",
          },
          next: "status.run",
        },
        { type: "action", key: "status.run", action: "status" },
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
    reconciliation: {
      enabled: true,
      schedule: "0 2 * * *",
      toleranceMinor: 100,
      feeToleranceMinor: overrides.feeToleranceMinor,
      suspenseAgeingDays: overrides.suspenseAgeingDays,
      notifyRole: "finance_admin",
      // Every rule ships disabled until the pilot supplies baselines (D46).
      anomalyRules: [
        {
          key: "collector_volume_drop",
          enabled: false,
          windowDays: 14,
          thresholdPercent: 30,
          severity: "warning",
        },
        {
          key: "collector_deposit_lag",
          enabled: false,
          windowDays: 7,
          thresholdMinor: 1,
          severity: "warning",
        },
        {
          key: "zone_compliance_drop",
          enabled: false,
          windowDays: 14,
          thresholdPercent: 20,
          severity: "warning",
        },
        {
          key: "officer_scan_volume_change",
          enabled: false,
          windowDays: 14,
          thresholdPercent: 50,
          severity: "info",
        },
        {
          key: "suspense_growth",
          enabled: false,
          windowDays: 7,
          thresholdMinor: overrides.bikeFee * 25,
          severity: "warning",
        },
      ],
    },
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
      feeToleranceMinor: 1000,
      suspenseAgeingDays: 7,
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
    cashDemo: {
      collectorUsername: "alpha.collector",
      ownerName: "Alpha Demo Owner",
      ownerPhone: "+2348000000001",
      plateNumber: "ALPHA001",
      shortCode: "B000001",
      clientReference: "seed-alpha-cash-day-1",
      provider: "mock",
      depositReference: "cash-dep-seed-alpha-collector",
    },
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
      feeToleranceMinor: 0,
      suspenseAgeingDays: 3,
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
  const now = new Date();
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
      // The seed owns the demo tenants' config: re-running it refreshes their
      // labels, asset schemas and rules instead of leaving a stale copy behind.
      if (existing !== undefined) {
        await repos.tenants.updateConfig(existing.id, config);
      }

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

      if (fake.cashDemo !== undefined) {
        await seedCollectorCashDay({
          repos,
          tenantId: tenant.id,
          config,
          demo: fake.cashDemo,
          now,
        });
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
