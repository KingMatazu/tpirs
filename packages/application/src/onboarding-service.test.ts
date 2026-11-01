import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import {
  MIN_PASSWORD_LENGTH,
  OnboardingValidationError,
  TEMPORARY_ADMIN_PASSWORD,
  TEMPORARY_ADMIN_USERNAME,
  completeOnboarding,
  credentialIssues,
  isSetupRequired,
  startOnboarding,
} from "./onboarding-service.js";
import type { StartOnboardingInput } from "./onboarding-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

function answers(slug: string): StartOnboardingInput {
  return {
    adminEmail: "admin@katsina-state.example.gov",
    zones: ["Central"],
    config: {
      name: "Katsina State",
      slug,
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
    },
  };
}

describe("credential rules", () => {
  it("refuses the provisioning username", () => {
    const issues = credentialIssues({ username: TEMPORARY_ADMIN_USERNAME, password: "correctly" });
    expect(issues.map((issue) => issue.path)).toEqual(["username"]);
  });

  it("refuses the provisioning password", () => {
    const issues = credentialIssues({
      username: "katsina.admin",
      password: TEMPORARY_ADMIN_PASSWORD,
    });
    expect(issues.map((issue) => issue.path)).toEqual(["password"]);
  });

  it("enforces the documented password floor", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(credentialIssues({ username: "katsina.admin", password: short })).toHaveLength(1);
    expect(
      credentialIssues({ username: "katsina.admin", password: "a".repeat(MIN_PASSWORD_LENGTH) }),
    ).toEqual([]);
  });

  it("refuses a password equal to the username, whatever the case", () => {
    expect(
      credentialIssues({ username: "levy.admin", password: "Levy.Admin" }).map((i) => i.path),
    ).toEqual(["password"]);
  });

  it("rejects usernames that are not lowercase and unambiguous", () => {
    for (const username of ["Admin!", "ab", "has space", "UPPER"]) {
      expect(credentialIssues({ username, password: "long-enough" })).not.toEqual([]);
    }
  });

  it("accepts a plausible pair", () => {
    expect(credentialIssues({ username: "aisha.bello", password: "levy-2026" })).toEqual([]);
  });
});

describeIntegration("onboarding (integration)", () => {
  let db: AnyDb;
  const stamp = `${Date.now().toString()}-onboarding`;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("reports whether onboarding is still needed", async () => {
    // The harness database carries tenants from other suites, so the empty case
    // cannot be reproduced here; this asserts the check reads the real table
    // rather than answering a constant.
    const tenants = await withSystem(db, (tx) => repositories(tx).tenants.list());
    expect(await isSetupRequired(db)).toBe(tenants.length === 0);
  });

  it("provisions a tenant, its roles, its zones and a temporary admin", async () => {
    const started = await startOnboarding(db, answers(`katsina-${stamp}`));
    expect(started.created).toBe(true);
    expect(started.temporaryUsername).toBe(TEMPORARY_ADMIN_USERNAME);

    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.findById(started.tenantId);
      expect(tenant?.config).toMatchObject({ identity: { slug: `katsina-${stamp}` } });

      const roles = await repos.roles.findByKey("system_admin", started.tenantId);
      expect(roles?.permissions).toContain("tenant:configure");

      const admin = await repos.users.findById(started.adminUserId);
      expect(admin?.username).toBe(TEMPORARY_ADMIN_USERNAME);
      expect(admin?.email).toBe("admin@katsina-state.example.gov");
      expect(admin?.mustChangeCredentials).toBe(true);
      // The temporary password is stored hashed, never in the clear.
      expect(admin?.passwordHash).not.toBe(TEMPORARY_ADMIN_PASSWORD);
    });
  });

  it("refuses a slug that is already provisioned", async () => {
    await expect(startOnboarding(db, answers(`katsina-${stamp}`))).rejects.toThrow(
      /already exists/,
    );
  });

  it("replaces the temporary credentials and clears the flag", async () => {
    const fresh = await startOnboarding(db, answers(`katsina-b-${stamp}`));
    const completed = await completeOnboarding(db, {
      tenantId: fresh.tenantId,
      userId: fresh.adminUserId,
      username: "aisha.bello",
      password: "levy-2026",
    });
    expect(completed.username).toBe("aisha.bello");

    await withSystem(db, async (tx) => {
      const user = await repositories(tx).users.findById(fresh.adminUserId);
      expect(user?.username).toBe("aisha.bello");
      expect(user?.mustChangeCredentials).toBe(false);
    });
  });

  it("refuses the temporary credentials at the last step", async () => {
    const fresh = await startOnboarding(db, answers(`katsina-c-${stamp}`));
    await expect(
      completeOnboarding(db, {
        tenantId: fresh.tenantId,
        userId: fresh.adminUserId,
        username: "katsina.admin",
        password: TEMPORARY_ADMIN_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(OnboardingValidationError);
  });

  it("reports configuration problems as issues rather than throwing a bare error", async () => {
    let thrown: unknown;
    try {
      await startOnboarding(db, {
        ...answers(`katsina-d-${stamp}`),
        adminEmail: "not-an-email",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OnboardingValidationError);
    expect((thrown as OnboardingValidationError).issues[0]?.path).toBe("adminEmail");
  });
});
