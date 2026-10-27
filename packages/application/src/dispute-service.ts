import { todayInTimeZone } from "@tpirs/domain";
import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb } from "@tpirs/db";
import type { ObjectStorage } from "@tpirs/ports";
import type { TenantConfigLoader } from "./asset-service.js";
import { AssetNotFoundError } from "./asset-service.js";

export interface DisputeServiceDeps {
  readonly db: AnyDb;
  readonly loadConfig: TenantConfigLoader;
  readonly objectStorage?: ObjectStorage;
  readonly now?: () => Date;
}

export interface CreateDisputeInput {
  readonly tenantId: string;
  readonly clientDisputeId: string;
  readonly reason: string;
  readonly description: string;
  readonly occurredAt: Date | string;
  readonly officerUserId: string;
  readonly assetId?: string;
  readonly reference?: string;
  readonly zoneId?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly evidence?: {
    readonly contentType: string;
    readonly contentBase64: string;
  };
}

export interface DisputeRecordView {
  readonly tenantId: string;
  readonly disputeId: string;
  readonly assetId: string;
  readonly reason: string;
  readonly status: "open" | "under_review" | "resolved" | "rejected";
  readonly businessDate: string;
}

export class DisputeService {
  constructor(private readonly deps: DisputeServiceDeps) {}

  async create(input: CreateDisputeInput): Promise<DisputeRecordView> {
    const config = await this.deps.loadConfig(input.tenantId);
    if (config === undefined) {
      throw new AssetNotFoundError("Tenant config not found");
    }
    if (!config.featureFlags.disputes) {
      throw new Error("Disputes are disabled for this tenant");
    }

    let assetId = input.assetId ?? null;
    const { reference } = input;
    if (assetId === null && reference !== undefined) {
      const found = await withTenant(this.deps.db, input.tenantId, async (tx) =>
        repositories(tx).assets.findByReference(reference),
      );
      if (found !== undefined) assetId = found.id;
    }
    if (assetId === null) {
      throw new AssetNotFoundError("Asset not found for dispute");
    }

    const businessDate = todayInTimeZone(config.locale.timezone, this.deps.now?.() ?? new Date());
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error("Invalid occurredAt");
    }

    const row = await withTenant(this.deps.db, input.tenantId, async (tx) =>
      repositories(tx).disputes.createIfAbsent({
        tenantId: input.tenantId,
        assetId,
        openedByUserId: input.officerUserId,
        zoneId: input.zoneId ?? null,
        clientDisputeId: input.clientDisputeId,
        reason: input.reason,
        description: input.description,
        occurredAt,
        businessDate,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      }),
    );

    if (row === undefined) {
      throw new Error("Dispute was not created");
    }

    const evidence = input.evidence;
    if (evidence !== undefined && this.deps.objectStorage) {
      const key = `tenants/${input.tenantId}/disputes/${row.id}/${Date.now()}.${evidence.contentType.split("/")[1] ?? "bin"}`;
      await this.deps.objectStorage.put({
        key,
        body: Buffer.from(evidence.contentBase64, "base64"),
        contentType: evidence.contentType,
      });
      await withTenant(this.deps.db, input.tenantId, async (tx) =>
        repositories(tx).disputes.attachEvidence({
          tenantId: input.tenantId,
          disputeId: row.id,
          objectKey: key,
          contentType: evidence.contentType,
        }),
      );
    }

    return {
      tenantId: input.tenantId,
      disputeId: row.id,
      assetId: row.assetId,
      reason: row.reason,
      status: row.status,
      businessDate,
    };
  }

  async list(
    tenantId: string,
    filter: { status?: string; cursor?: string; limit?: number; officerUserId?: string },
  ) {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).disputes.list(tenantId, {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
        ...(filter.limit === undefined ? {} : { limit: filter.limit }),
        ...(filter.officerUserId === undefined ? {} : { openedByUserId: filter.officerUserId }),
      }),
    );
  }

  async get(tenantId: string, disputeId: string) {
    return withTenant(this.deps.db, tenantId, async (tx) =>
      repositories(tx).disputes.find(tenantId, disputeId),
    );
  }
}

export function createDisputeService(deps: DisputeServiceDeps): DisputeService {
  return new DisputeService(deps);
}
