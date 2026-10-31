import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { validateTenantConfig } from "@tpirs/config";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { createMockSmsProvider } from "@tpirs/sms-provider-mock";
import type { MockSmsProvider } from "@tpirs/sms-provider-mock";
import type { Telemetry } from "@tpirs/ports";
import { createWorker } from "./worker.js";
import type { Worker } from "./worker.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../../packages/db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

/** A minimal telemetry sink, so the test records rather than reports. */
const telemetry: Telemetry = {
  startSpan: () => ({
    setAttribute: () => undefined,
    recordException: () => undefined,
    end: () => undefined,
  }),
  counter: () => undefined,
  gauge: () => undefined,
  log: () => undefined,
  captureError: () => undefined,
};

/** A tenant whose outbox already holds one rendered receipt. */
async function tenantWithPendingReceipt(db: AnyDb): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenantId = await withSystem(db, async (tx) => {
    const created = await repositories(tx).tenants.create({
      slug: `worker-${stamp}`,
      name: "Worker",
      legalEntity: "Worker Revenue",
      config: {},
    });
    return created.id;
  });
  await withTenant(db, tenantId, async (tx) => {
    const repos = repositories(tx);
    const asset = await repos.assets.create({
      tenantId,
      zoneId: null,
      ownerId: null,
      assetTypeKey: "bike",
      attributes: {},
      qrPayload: `worker-${stamp}`,
      qrToken: `worker-${stamp}-token`,
      shortCode: "W1",
      createdByUserId: null,
    });
    const period = await repos.obligations.create(tenantId, {
      assetId: asset.id,
      periodKey: "2026-06-15",
      businessDate: "2026-06-15",
      amountMinor: 20_000n,
      currency: "NGN",
    });
    await repos.smsLog.enqueue(tenantId, {
      kind: "receipt",
      recipient: "+2348099999999",
      obligationPeriodId: period.id,
      body: "Your levy payment is recorded",
    });
  });
  return tenantId;
}

/** A tenant with a stored, valid reconciliation config for 2026-06-15. */
async function tenantWithReconciliationConfig(
  db: AnyDb,
  options: { readonly enabled?: boolean } = {},
): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const config = validateTenantConfig({
    identity: {
      name: "Scheduled Worker",
      slug: `sched-worker-${stamp}`.slice(0, 30),
      legalEntity: "Scheduled Worker Revenue",
      supportContacts: { email: "a@b.co", phone: "+1" },
    },
    locale: {
      defaultLanguage: "en",
      enabledLanguages: ["en"],
      timezone: "Etc/UTC",
      currency: "NGN",
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: "Scheduled",
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "X",
      receiptHeader: "State Revenue",
      receiptFooter: "f",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [],
        qrFormat: "W-{id}",
        shortCodeFormat: "W{id}",
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
          amountMinor: 20_000,
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
      floatCeilingMinor: 1_000_000,
      depositDeadlineHours: 8,
      freezeOnShortfall: true,
    },
    payments: { underpaymentPolicy: "wallet" },
    featureFlags: { disputes: true, prepay: false, offlineMode: true, anomalyAlerts: true },
    reconciliation: {
      enabled: options.enabled ?? true,
      schedule: "0 2 * * *",
      toleranceMinor: 0,
      feeToleranceMinor: 0,
      suspenseAgeingDays: 7,
      notifyRole: "finance_admin",
      anomalyRules: [],
    },
    field: {
      offlineGraceHours: 8,
      maxQueueItems: 1000,
      disputeReasons: [{ code: "other", label: "Other" }],
    },
    compliance: { retentionDays: 1, dataResidency: "x", consentTextKey: "c" },
  });
  const tenant = await withSystem(db, async (tx) =>
    repositories(tx).tenants.create({
      slug: `sched-worker-${stamp}`.slice(0, 30),
      name: "Scheduled Worker",
      legalEntity: "Scheduled Worker Revenue",
      config,
    }),
  );
  return tenant.id;
}

/** Only this test's tenant, so a shared database cannot schedule another suite's. */
function onlyTenant(db: AnyDb, tenantId: string) {
  return async () => {
    const row = await withSystem(db, async (tx) => repositories(tx).tenants.findById(tenantId));
    return row === undefined ? [] : [{ id: row.id, config: row.config }];
  };
}

describeIntegration("worker (integration)", () => {
  let db: AnyDb;
  let sms: MockSmsProvider;
  let worker: Worker;

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await worker.stop();
    await db.destroy();
  });

  // The suite runs every package in parallel, so the polling loop can be slow;
  // the assertion is eventual delivery, not latency.
  it("sweeps a pending receipt and delivers it through the gateway", async () => {
    const tenantId = await tenantWithPendingReceipt(db);
    sms = createMockSmsProvider();
    worker = createWorker({
      db,
      sms,
      telemetry,
      sweepIntervalMs: 60_000,
      // The receipt test has nothing to reconcile; keep the scheduler quiet.
      reconciliationTenants: async () => [],
    });

    // `start` runs one sweep immediately, then a slow timer keeps the test quiet.
    await worker.start();
    const delivered = await waitFor(() => sms.sent.some((m) => m.to === "+2348099999999"), 60_000);
    expect(delivered).toBe(true);
    const mine = sms.sent.find((m) => m.to === "+2348099999999");
    expect(mine?.text).toBe("Your levy payment is recorded");

    await worker.stop();

    const status = await withTenant(db, tenantId, async (tx) => {
      const rows = await repositories(tx).smsLog.claimPending(tenantId, 10);
      return rows.length;
    });
    // Delivered, so it is no longer claimable as pending work.
    expect(status).toBe(0);
  }, 120_000);

  it("schedules the closed business day, runs it and records the attempt", async () => {
    const tenantId = await tenantWithReconciliationConfig(db);
    sms = createMockSmsProvider();
    worker = createWorker({
      db,
      sms,
      telemetry,
      sweepIntervalMs: 60_000,
      cashSweepIntervalMs: 60_000,
      reconciliationIntervalMs: 60_000,
      reconciliationTenants: onlyTenant(db, tenantId),
      // 02:00:05 on 16 June: the schedule for the 15th has just passed.
      now: () => new Date("2026-06-16T02:00:05Z"),
    });

    await worker.start();
    const deadline = Date.now() + 10_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      status = await withTenant(db, tenantId, async (tx) => {
        const run = await repositories(tx).reconciliation.findLatest(tenantId, "2026-06-15");
        return run?.status;
      });
      if (status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await worker.stop();

    expect(status).toBe("completed");
    const run = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).reconciliation.findLatest(tenantId, "2026-06-15"),
    );
    expect(run?.runSeq).toBe(1);
    expect(run?.exceptionCount).toBe(0);
  });
});

/** Waits for a condition, so the test never races the polling loop. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}
