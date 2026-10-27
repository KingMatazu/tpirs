import { todayInTimeZone, paymentStatusFromPeriod } from "@tpirs/domain";
import type { PaymentStatus } from "@tpirs/domain";
import type { AssetRecord } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { TenantConfigLoader } from "./asset-service.js";
import { AssetNotFoundError } from "./asset-service.js";

export interface ScanServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: TenantConfigLoader;
  readonly now?: () => Date;
}

export interface RecordScanInput {
  readonly tenantId: string;
  readonly clientScanId: string;
  readonly source: "qr" | "manual" | "offline_queue";
  readonly officerUserId: string;
  readonly assetId?: string;
  readonly token?: string;
  readonly reference?: string;
  readonly observedStatus?: PaymentStatus | "not_in_offline_list";
  readonly scannedAt: Date | string;
  readonly deviceId?: string | null;
  readonly zoneId?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}

export interface ScanRecordResult {
  readonly tenantId: string;
  readonly assetId: string;
  readonly businessDate: string;
  readonly scanId: string;
  readonly observedStatus: PaymentStatus | "not_in_offline_list";
  readonly authoritativeStatus: PaymentStatus;
  readonly paymentStatus: PaymentStatus;
  readonly shortCode?: string;
  readonly attributes?: Record<string, unknown>;
}

async function resolveAssetForScan(
  db: AnyDb,
  tenantId: string,
  input: Pick<RecordScanInput, "assetId" | "token" | "reference">,
): Promise<AssetRecord | undefined> {
  const { assetId, token, reference } = input;
  if (assetId !== undefined && assetId.length > 0) {
    const resolved = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).assets.findById(assetId),
    );
    if (resolved !== undefined) return resolved;
  }

  if (token !== undefined && token.length > 0) {
    const payload = token.includes(".") ? token.split(".").slice(0, -1).join(".") : token;
    const resolved = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).assets.findByQrPayload(payload),
    );
    if (resolved !== undefined) return resolved;
  }

  if (reference !== undefined && reference.length > 0) {
    const resolved = await withTenant(db, tenantId, async (tx) =>
      repositories(tx).assets.findByReference(reference),
    );
    if (resolved !== undefined) return resolved;
  }

  return undefined;
}

export class ScanService {
  constructor(private readonly deps: ScanServiceDeps) {}

  async record(input: RecordScanInput): Promise<ScanRecordResult> {
    const config = await this.deps.loadConfig(input.tenantId);
    const now = this.deps.now?.() ?? new Date();
    const businessDate = todayInTimeZone(config?.locale.timezone ?? "UTC", now);

    const asset = await resolveAssetForScan(this.deps.db, input.tenantId, input);
    if (asset === undefined) {
      throw new AssetNotFoundError("Asset not found for scan");
    }

    const period = await withTenant(this.deps.db, input.tenantId, async (tx) =>
      repositories(tx).obligations.findByAssetAndDate(input.tenantId, asset.id, businessDate),
    );
    const paymentStatus = paymentStatusFromPeriod(period?.status ?? "none");
    const observedStatus = input.observedStatus ?? paymentStatus;
    const scannedAt = new Date(input.scannedAt);
    if (Number.isNaN(scannedAt.getTime())) {
      throw new Error("Invalid scannedAt");
    }

    const row = await withTenant(this.deps.db, input.tenantId, async (tx) =>
      repositories(tx).scans.insertIfAbsent({
        tenantId: input.tenantId,
        assetId: asset.id,
        officerUserId: input.officerUserId,
        deviceId: input.deviceId ?? "unknown",
        clientScanId: input.clientScanId,
        source: input.source,
        observedStatus,
        authoritativeStatus: paymentStatus,
        businessDate,
        scannedAt,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        zoneId: input.zoneId ?? null,
      }),
    );

    if (row === undefined) {
      throw new Error("Scan was not recorded");
    }

    return {
      tenantId: input.tenantId,
      assetId: asset.id,
      businessDate,
      scanId: row.id,
      observedStatus,
      authoritativeStatus: paymentStatus,
      paymentStatus,
      shortCode: asset.shortCode,
      attributes: asset.attributes,
    };
  }
}

export function createScanService(deps: ScanServiceDeps): ScanService {
  return new ScanService(deps);
}
