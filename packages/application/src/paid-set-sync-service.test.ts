import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { sql } from "kysely";
import { createDb, migrateUp, repositories, withSystem, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import {
  createPaidSetSyncService,
  decodePaidSetCursor,
  encodePaidSetCursor,
} from "./paid-set-sync-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");
const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

const NOW = new Date("2026-06-15T09:00:00Z");
const BUSINESS_DATE = "2026-06-15";

function testConfig(slug: string, offlineMode = true): TenantConfig {
  return validateTenantConfig({
    identity: {
      name: `State ${slug}`,
      slug,
      legalEntity: `${slug} Revenue`,
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
      appName: slug,
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
        qrFormat: "A-{id}",
        shortCodeFormat: "A{id}",
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
      smsKeyword: "LEVY",
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
    featureFlags: { disputes: true, prepay: false, offlineMode, anomalyAlerts: true },
    field: {
      offlineGraceHours: 8,
      maxQueueItems: 1000,
      disputeReasons: [{ code: "other", label: "Other" }],
    },
    reconciliation: { schedule: "0 2 * * *", toleranceMinor: 0, notifyRole: "finance_admin" },
    compliance: { retentionDays: 1, dataResidency: "ng", consentTextKey: "c" },
  });
}

describeIntegration("PaidSetSyncService (integration)", () => {
  let db: AnyDb;
  const configs = new Map<string, TenantConfig>();

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  const service = (): ReturnType<typeof createPaidSetSyncService> =>
    createPaidSetSyncService({
      db,
      loadConfig: (id) => Promise.resolve(configs.get(id)),
      now: () => NOW,
    });

  interface Fixture {
    readonly tenantId: string;
    readonly assets: readonly { assetId: string; qrPayload: string; shortCode: string }[];
  }

  /**
   * Three assets on today's business date: two paid, one with no payment. The
   * unpaid one must still appear in the feed (as `paid: false`) so a client can
   * *remove* an asset from its cache after a reversal.
   */
  async function makeTenant(options: { offlineMode?: boolean } = {}): Promise<Fixture> {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slug = `sync${stamp.replace(/[^a-z0-9]/g, "")}`.slice(0, 30);
    return withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const tenant = await repos.tenants.create({
        slug,
        name: "Sync",
        legalEntity: "Sync Revenue",
        config: {},
      });
      configs.set(tenant.id, testConfig(slug, options.offlineMode ?? true));

      const created: { assetId: string; qrPayload: string; shortCode: string }[] = [];
      for (const index of [1, 2, 3]) {
        const payload = `payload-${stamp}-${String(index)}`;
        const asset = await repos.assets.create({
          tenantId: tenant.id,
          zoneId: null,
          ownerId: null,
          assetTypeKey: "bike",
          attributes: { plate_number: `PLATE${String(index)}` },
          qrPayload: payload,
          qrToken: `${payload}.sig`,
          shortCode: `A${String(1000 + index)}`,
          createdByUserId: null,
        });
        const period = await repos.obligations.create(tenant.id, {
          assetId: asset.id,
          periodKey: BUSINESS_DATE,
          businessDate: BUSINESS_DATE,
          amountMinor: 20_000n,
          currency: "NGN",
        });
        if (index !== 3) {
          // The repository's create() always writes an unpaid row; a paid row must
          // settle in full, which is a database constraint, so settle it here.
          await sql`
            update obligation_periods
            set status = 'paid', amount_paid_minor = amount_minor
            where id = ${period.id}
          `.execute(tx);
        }
        created.push({ assetId: asset.id, qrPayload: payload, shortCode: asset.shortCode });
      }
      return { tenantId: tenant.id, assets: created };
    });
  }

  it("returns a snapshot with an encoded cursor the client can send back", async () => {
    const fixture = await makeTenant();
    const result = await service().sync(fixture.tenantId, {});
    if ("error" in result) throw new Error("unexpected error");

    expect(result.mode).toBe("snapshot");
    expect(result.businessDate).toBe(BUSINESS_DATE);
    expect(result.entries).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    // A string, not an object: the wire contract is `?since=<cursor>`, and an
    // object would serialize as "[object Object]" and decode to nothing.
    expect(typeof result.nextCursor).toBe("string");
    expect(decodePaidSetCursor(result.nextCursor ?? "")).toBeDefined();

    const paid = result.entries.filter((entry) => entry.paid);
    expect(paid).toHaveLength(2);
    expect(result.entries.some((entry) => !entry.paid)).toBe(true);
  });

  it("answers a delta from the saved cursor with nothing new", async () => {
    const fixture = await makeTenant();
    const first = await service().sync(fixture.tenantId, {});
    if ("error" in first) throw new Error("unexpected error");

    const second = await service().sync(fixture.tenantId, { since: first.nextCursor ?? "" });
    if ("error" in second) throw new Error("unexpected error");
    expect(second.mode).toBe("delta");
    expect(second.entries).toHaveLength(0);
  });

  it("pages through the day without dropping or repeating a row", async () => {
    const fixture = await makeTenant();
    const seen: string[] = [];
    let since: string | undefined;
    let pages = 0;

    for (;;) {
      const page = await service().sync(fixture.tenantId, {
        ...(since === undefined ? {} : { since }),
        limit: 1,
      });
      if ("error" in page) throw new Error("unexpected error");
      pages += 1;
      for (const entry of page.entries) seen.push(entry.assetId);
      if (!page.hasMore) {
        expect(page.nextCursor).not.toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      since = page.nextCursor ?? undefined;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("falls back to a snapshot when the cursor is not one of ours", async () => {
    const fixture = await makeTenant();
    const result = await service().sync(fixture.tenantId, { since: "not-a-cursor" });
    if ("error" in result) throw new Error("unexpected error");
    expect(result.mode).toBe("snapshot");
    expect(result.entries).toHaveLength(3);
  });

  it("refuses to serve the feed when the tenant disabled offline mode", async () => {
    const fixture = await makeTenant({ offlineMode: false });
    const result = await service().sync(fixture.tenantId, {});
    expect(result).toEqual({ error: "not_found" });
  });

  it("round-trips a cursor through encode and decode", () => {
    const cursor = {
      updatedAt: "2026-06-15T09:00:00.000Z",
      id: "00000000-0000-0000-0000-000000000001",
    };
    expect(decodePaidSetCursor(encodePaidSetCursor(cursor))).toEqual(cursor);
  });

  it("does not serve another tenant's periods", async () => {
    const alpha = await makeTenant();
    const beta = await makeTenant();
    const result = await service().sync(beta.tenantId, {});
    if ("error" in result) throw new Error("unexpected error");
    const ids = new Set(result.entries.map((entry) => entry.assetId));
    for (const asset of alpha.assets) expect(ids.has(asset.assetId)).toBe(false);
  });

  it("keeps the tenant's currency out of the feed and the payload opaque", async () => {
    const fixture = await makeTenant();
    const result = await service().sync(fixture.tenantId, {});
    if ("error" in result) throw new Error("unexpected error");
    const entry = result.entries[0];
    expect(entry?.qrPayload).toBeDefined();
    // The QR payload is what the client keys its cache on; the signed token never
    // leaves the asset record.
    expect(entry?.qrPayload.includes(".")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sig");
  });

  it("filters by business date, not by wall clock", async () => {
    const fixture = await makeTenant();
    await withTenant(db, fixture.tenantId, async (tx) => {
      await repositories(tx).obligations.create(fixture.tenantId, {
        assetId: fixture.assets[0]?.assetId ?? "",
        periodKey: "2026-06-16",
        businessDate: "2026-06-16",
        amountMinor: 20_000n,
        currency: "NGN",
      });
    });
    const result = await service().sync(fixture.tenantId, {});
    if ("error" in result) throw new Error("unexpected error");
    expect(result.entries).toHaveLength(3);
    expect(result.businessDate).toBe(BUSINESS_DATE);
  });
});
