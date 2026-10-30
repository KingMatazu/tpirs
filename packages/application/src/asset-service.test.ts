import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createDb, migrateUp, repositories, withSystem } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import { validateTenantConfig } from "@tpirs/config";
import type { TenantConfig } from "@tpirs/config";
import { createQrTokenSigner } from "@tpirs/crypto";
import { createConfigAssetSchemaRegistry } from "@tpirs/asset-schema-registry-config";
import { createMockObjectStorage } from "@tpirs/object-storage-mock";
import { parseQrToken } from "@tpirs/domain";
import { AssetValidationError, createAssetService } from "./asset-service.js";
import type { AssetService } from "./asset-service.js";

const TEST_URL = process.env.TEST_DATABASE_URL;
const migrationsDir = path.resolve(import.meta.dirname, "../../db/migrations");

const describeIntegration = TEST_URL === undefined ? describe.skip : describe;

function testConfig(slug: string, currency: string): TenantConfig {
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
      timezone: "Africa/Lagos",
      currency,
      numberFormat: "en-NG",
      dateFormat: "dd/MM/yyyy",
    },
    branding: {
      appName: slug,
      logoUrl: "https://x/logo.svg",
      colors: { primary: "#000", secondary: "#111", accent: "#222" },
      smsSenderId: "X",
      receiptHeader: "h",
      receiptFooter: "f",
    },
    assetTypes: [
      {
        key: "bike",
        label: "Bike",
        attributes: [
          { key: "plate_number", label: "Plate number", type: "string", required: true },
        ],
        qrFormat: `${slug}-{id}`,
        shortCodeFormat: `${slug[0]?.toUpperCase() ?? "X"}{id}`,
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

describeIntegration("createAssetService (integration)", () => {
  let db: AnyDb;
  let alphaTenantId: string;
  let betaTenantId: string;
  let service: AssetService;
  const signer = createQrTokenSigner("test-qr-key");

  beforeAll(async () => {
    if (TEST_URL === undefined) return;
    db = createDb({ connectionString: TEST_URL });
    await migrateUp(db, migrationsDir);
    const stamp = Date.now().toString();
    await withSystem(db, async (tx) => {
      const repos = repositories(tx);
      const alpha = await repos.tenants.create({
        slug: `alpha-${stamp}`,
        name: "Alpha",
        legalEntity: "Alpha Revenue",
        config: {},
      });
      const beta = await repos.tenants.create({
        slug: `beta-${stamp}`,
        name: "Beta",
        legalEntity: "Beta Revenue",
        config: {},
      });
      alphaTenantId = alpha.id;
      betaTenantId = beta.id;
    });

    const configs = new Map<string, TenantConfig>([
      [alphaTenantId, testConfig("alpha", "NGN")],
      [betaTenantId, testConfig("beta", "GHS")],
    ]);
    const loadConfig = (id: string) => Promise.resolve(configs.get(id));
    service = createAssetService({
      db,
      registry: createConfigAssetSchemaRegistry({ loadConfig }),
      qrSigner: signer,
      objectStorage: createMockObjectStorage("test-bucket"),
      loadConfig,
    });
  });

  afterAll(async () => {
    if (TEST_URL === undefined) return;
    await db.destroy();
  });

  it("registers an asset with a verifiable QR token and a configured short code", async () => {
    const asset = await service.register({
      tenantId: alphaTenantId,
      assetTypeKey: "bike",
      attributes: { plate_number: "ABC123" },
      owner: { displayName: "Owner One", phone: "+2348000000001" },
    });
    expect(asset.assetTypeKey).toBe("bike");
    expect(asset.status).toBe("active");
    expect(asset.ownerId).not.toBeNull();
    expect(asset.shortCode.startsWith("A")).toBe(true);
    const payload = parseQrToken(asset.qrToken, signer);
    expect(payload).toBe(asset.qrPayload);

    const found = await service.getById(alphaTenantId, asset.id);
    expect(found.id).toBe(asset.id);
  });

  it("rejects attributes that violate the asset type schema", async () => {
    await expect(
      service.register({
        tenantId: alphaTenantId,
        assetTypeKey: "bike",
        attributes: {},
      }),
    ).rejects.toThrow(AssetValidationError);
  });

  it("filters a search by short code or plate, and returns nothing for a miss", async () => {
    await service.register({
      tenantId: alphaTenantId,
      assetTypeKey: "bike",
      attributes: { plate_number: "SEARCHME" },
    });

    // The free-text filter used to be dropped on the way to the repository, so
    // every search returned the first page regardless of what was typed.
    const hit = await service.search({ tenantId: alphaTenantId, query: "SEARCHME" });
    expect(hit).toHaveLength(1);
    expect(hit[0]?.attributes["plate_number"]).toBe("SEARCHME");

    const shortCode = hit[0]?.shortCode ?? "";
    const byShortCode = await service.search({ tenantId: alphaTenantId, query: shortCode });
    expect(byShortCode.map((asset) => asset.id)).toContain(hit[0]?.id);

    const miss = await service.search({ tenantId: alphaTenantId, query: "NO-SUCH-PLATE" });
    expect(miss).toEqual([]);
  });

  it("cannot read another tenant's asset (row-level security)", async () => {
    const asset = await service.register({
      tenantId: alphaTenantId,
      assetTypeKey: "bike",
      attributes: { plate_number: "SECRET" },
    });
    await expect(service.getById(betaTenantId, asset.id)).rejects.toThrow();
  });

  it("suspends and re-validates corrected attributes", async () => {
    const asset = await service.register({
      tenantId: betaTenantId,
      assetTypeKey: "bike",
      attributes: { plate_number: "BETA1" },
    });
    const suspended = await service.setStatus(betaTenantId, asset.id, "suspended");
    expect(suspended.status).toBe("suspended");

    await expect(service.correctAttributes(betaTenantId, asset.id, {})).rejects.toThrow(
      AssetValidationError,
    );
    const corrected = await service.correctAttributes(betaTenantId, asset.id, {
      plate_number: "BETA2",
    });
    expect(corrected.attributes).toEqual({ plate_number: "BETA2" });
  });

  it("attaches a photo through object storage", async () => {
    const asset = await service.register({
      tenantId: alphaTenantId,
      assetTypeKey: "bike",
      attributes: { plate_number: "PHOTO1" },
    });
    await service.attachPhoto({
      tenantId: alphaTenantId,
      assetId: asset.id,
      contentType: "image/png",
      body: new Uint8Array([1, 2, 3]),
    });
    const photos = await service.listPhotos(alphaTenantId, asset.id);
    expect(photos).toHaveLength(1);
    expect(photos[0]?.contentType).toBe("image/png");
  });
});
