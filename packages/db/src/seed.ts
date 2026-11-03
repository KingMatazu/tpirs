import { createDb, type AnyDb } from "./connection.js";
import { withSystem } from "./tenant-scope.js";
import { repositories } from "./repositories/index.js";
import { provisionTenantRows } from "./provisioning.js";
import { SYSTEM_ROLES } from "@tpirs/domain";
import { hashPassword } from "@tpirs/crypto";
import { defaultTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { seedCollectorCashDay, type CashDemoSeed } from "./seed-cash.js";

/**
 * Demo tenants for local development and the demo deployment.
 *
 * This file is fixtures only. Creating the tenant, its roles, its zones and its
 * first user is `provisionTenantRows`, the same routine first-run onboarding
 * uses, so a demo tenant and a real one cannot drift apart. What is left here is
 * what makes a tenant a *demo*: a few extra staff accounts, distinct
 * configuration a side-by-side test can tell apart, and one settled cash day.
 *
 * It is also the only place in the repository with fixed passwords, which is why
 * `runSeed` refuses to run against production without an explicit override.
 */

export type SeedFn = (db: AnyDb) => Promise<void>;

interface DemoUser {
  readonly username: string;
  readonly displayName: string;
  readonly password: string;
  readonly roleKeys: readonly string[];
}

interface FakeTenant {
  readonly slug: string;
  readonly config: TenantConfig;
  readonly zones: readonly string[];
  /** The first user is the tenant's admin; the rest are demo staff. */
  readonly users: readonly DemoUser[];
  /** One settled cash day for the demo collector, when the tenant wants one. */
  readonly cashDemo?: CashDemoSeed;
}

/** Demo accounts share the tenant's synthetic domain; nothing is ever mailed. */
function demoEmail(slug: string, username: string): string {
  return `${username}@${slug}.example.gov`;
}

const FAKE_TENANTS: readonly FakeTenant[] = [
  {
    slug: "alpha-state",
    config: defaultTenantConfig({
      name: "Alpha State",
      slug: "alpha-state",
      legalEntity: "Alpha State Revenue Authority",
      supportEmail: "support@alpha-state.example.gov",
      supportPhone: "+2348000000000",
      timezone: "Africa/Lagos",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
      appName: "Alpha Levy",
      logoUrl: "https://cdn.alpha-state.example.gov/logo.svg",
      smsSenderId: "ALPHALEVY",
      smsKeyword: "LEVY",
      ussdCode: "*347*1#",
      bikeFeeMinor: 20000,
      tuktukFeeMinor: 30000,
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
    config: defaultTenantConfig({
      name: "Beta State",
      slug: "beta-state",
      legalEntity: "Beta State Transport Levy Board",
      supportEmail: "support@beta-state.example.gov",
      supportPhone: "+000000000000",
      timezone: "Africa/Accra",
      currency: "GHS",
      numberFormat: "en-GH",
      dateFormat: "yyyy-MM-dd",
      appName: "Beta Levy",
      logoUrl: "https://cdn.beta-state.example.gov/logo.svg",
      smsSenderId: "BETALEVY",
      smsKeyword: "LEVY",
      ussdCode: "*124#",
      bikeFeeMinor: 500,
      tuktukFeeMinor: 800,
      languages: ["fr", "en"],
      defaultLanguage: "fr",
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
 * Seeds the demo tenants. No code branches on tenant identity: everything that
 * differs lives in the validated config, and roles come from the shared system
 * role definitions.
 */
export const seed: SeedFn = async (db) => {
  const now = new Date();
  for (const fake of FAKE_TENANTS) {
    const [admin, ...staff] = fake.users;
    if (admin === undefined) continue;

    // Tenant, roles, zones and the admin account: the same provisioning routine
    // onboarding calls. `updateExisting` because the seed owns these configs and
    // re-running it should refresh them rather than fail on the first tenant.
    const provisioned = await provisionTenantRows(db, {
      config: fake.config,
      zones: fake.zones,
      updateExisting: true,
      admin: {
        username: admin.username,
        displayName: admin.displayName,
        email: demoEmail(fake.slug, admin.username),
        password: admin.password,
        roleKeys: admin.roleKeys,
        // Demo accounts sign in directly; onboarding's temporary-credential
        // gate would only get in the way of a demo.
        mustChangeCredentials: false,
      },
    });

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);

      const roleIds = new Map<string, string>();
      for (const role of SYSTEM_ROLES) {
        const existing = await repos.roles.findByKey(role.key, provisioned.tenantId);
        if (existing !== undefined) roleIds.set(role.key, existing.id);
      }

      for (const user of staff) {
        const found = await repos.users.findByUsernameInTenant(provisioned.tenantId, user.username);
        if (found !== undefined) continue;
        const created = await repos.users.create({
          tenantId: provisioned.tenantId,
          username: user.username,
          displayName: user.displayName,
          email: demoEmail(fake.slug, user.username),
          passwordHash: await hashPassword(user.password),
          totpSecret: null,
        });
        for (const roleKey of user.roleKeys) {
          const roleId = roleIds.get(roleKey);
          if (roleId !== undefined) {
            await repos.roles.assignToUser({
              tenantId: provisioned.tenantId,
              userId: created.id,
              roleId,
            });
          }
        }
        // The first role listed is the one the demo account was made for; the
        // rest are extra access. Set after the grants so the partial unique index
        // has a row to mark.
        const primaryRoleKey = user.roleKeys.find((roleKey) => roleIds.has(roleKey));
        const primaryRoleId =
          primaryRoleKey === undefined ? undefined : roleIds.get(primaryRoleKey);
        if (primaryRoleId !== undefined) {
          await repos.roles.setPrimaryRoleForUser({ userId: created.id, roleId: primaryRoleId });
        }
      }

      if (fake.cashDemo !== undefined) {
        await seedCollectorCashDay({
          repos,
          tenantId: provisioned.tenantId,
          config: fake.config,
          demo: fake.cashDemo,
          now,
        });
      }
    });
  }
};

/**
 * The demo seed writes accounts with passwords that are in this file, so it must
 * never touch a production database by accident. `pnpm setup --seed` sets the
 * override deliberately; nothing else should.
 */
export function assertDemoSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production" && env.ALLOW_DEMO_SEED !== "true") {
    throw new Error(
      "Refusing to seed demo tenants with NODE_ENV=production. " +
        "Set ALLOW_DEMO_SEED=true to override, or onboard a real tenant instead.",
    );
  }
}

export async function runSeed(connectionString: string): Promise<void> {
  assertDemoSeedAllowed(process.env);
  const db = createDb({ connectionString });
  try {
    await seed(db);
  } finally {
    await db.destroy();
  }
}
