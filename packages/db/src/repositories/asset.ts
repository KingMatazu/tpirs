import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import type { AssetRow } from "../connection.js";

export interface AssetRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly zoneId: string | null;
  readonly ownerId: string | null;
  readonly assetTypeKey: string;
  readonly status: string;
  readonly attributes: Record<string, unknown>;
  readonly qrPayload: string;
  readonly qrToken: string;
  readonly shortCode: string;
}

export interface CreateAssetInput {
  readonly tenantId: string;
  readonly zoneId: string | null;
  readonly ownerId: string | null;
  readonly assetTypeKey: string;
  readonly attributes: Record<string, unknown>;
  readonly qrPayload: string;
  readonly qrToken: string;
  readonly shortCode: string;
  readonly createdByUserId: string | null;
}

export interface AssetSearchFilter {
  readonly assetTypeKey?: string;
  readonly status?: string;
  readonly zoneId?: string;
  readonly ownerId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const ASSET_COLUMNS = [
  "tenantId",
  "id",
  "zoneId",
  "ownerId",
  "assetTypeKey",
  "status",
  "attributes",
  "qrPayload",
  "qrToken",
  "shortCode",
] as const;

type SelectedAssetRow = Pick<AssetRow, (typeof ASSET_COLUMNS)[number]>;

function toRecord(row: SelectedAssetRow): AssetRecord {
  const attributes =
    typeof row.attributes === "object" && row.attributes !== null
      ? (row.attributes as Record<string, unknown>)
      : {};
  return {
    tenantId: row.tenantId,
    id: row.id,
    zoneId: row.zoneId,
    ownerId: row.ownerId,
    assetTypeKey: row.assetTypeKey,
    status: row.status,
    attributes,
    qrPayload: row.qrPayload,
    qrToken: row.qrToken,
    shortCode: row.shortCode,
  };
}

export class AssetRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: CreateAssetInput): Promise<AssetRecord> {
    const row = await this.db
      .insertInto("assets")
      .values({
        tenantId: input.tenantId,
        zoneId: input.zoneId,
        ownerId: input.ownerId,
        assetTypeKey: input.assetTypeKey,
        attributes: input.attributes,
        qrPayload: input.qrPayload,
        qrToken: input.qrToken,
        shortCode: input.shortCode,
        createdByUserId: input.createdByUserId,
      })
      .returning(ASSET_COLUMNS)
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async findById(id: string): Promise<AssetRecord | undefined> {
    const row = await this.db
      .selectFrom("assets")
      .select(ASSET_COLUMNS)
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async findByQrPayload(qrPayload: string): Promise<AssetRecord | undefined> {
    const row = await this.db
      .selectFrom("assets")
      .select(ASSET_COLUMNS)
      .where("qrPayload", "=", qrPayload)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async findByShortCode(shortCode: string): Promise<AssetRecord | undefined> {
    const row = await this.db
      .selectFrom("assets")
      .select(ASSET_COLUMNS)
      .where("shortCode", "=", shortCode)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async search(filter: AssetSearchFilter): Promise<readonly AssetRecord[]> {
    let query = this.db.selectFrom("assets").select(ASSET_COLUMNS);
    if (filter.assetTypeKey !== undefined) {
      query = query.where("assetTypeKey", "=", filter.assetTypeKey);
    }
    if (filter.status !== undefined) {
      query = query.where("status", "=", filter.status);
    }
    if (filter.zoneId !== undefined) {
      query = query.where("zoneId", "=", filter.zoneId);
    }
    if (filter.ownerId !== undefined) {
      query = query.where("ownerId", "=", filter.ownerId);
    }
    const rows = await query
      .orderBy("createdAt", "desc")
      .limit(filter.limit ?? 50)
      .offset(filter.offset ?? 0)
      .execute();
    return rows.map(toRecord);
  }

  /**
   * Every asset in the tenant, unpaginated. Used by background jobs that must
   * touch all assets (for example scheduled period generation); request
   * handlers use `search` instead.
   */
  async listAll(tenantId: string): Promise<readonly AssetRecord[]> {
    const rows = await this.db
      .selectFrom("assets")
      .select(ASSET_COLUMNS)
      .where("tenantId", "=", tenantId)
      .orderBy("id", "asc")
      .execute();
    return rows.map(toRecord);
  }

  /** Updates status and/or attributes; returns the updated asset. */
  async update(
    id: string,
    patch: { status?: string; attributes?: Record<string, unknown>; zoneId?: string | null },
  ): Promise<AssetRecord> {
    const row = await this.db
      .updateTable("assets")
      .set({
        updatedAt: new Date(),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.attributes === undefined ? {} : { attributes: patch.attributes }),
        ...(patch.zoneId === undefined ? {} : { zoneId: patch.zoneId }),
      })
      .where("id", "=", id)
      .returning(ASSET_COLUMNS)
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }
}
