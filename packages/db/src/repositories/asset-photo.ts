import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface AssetPhotoRecord {
  readonly id: string;
  readonly assetId: string;
  readonly objectKey: string;
  readonly contentType: string;
}

export class AssetPhotoRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: {
    tenantId: string;
    assetId: string;
    objectKey: string;
    contentType: string;
    createdByUserId: string | null;
  }): Promise<AssetPhotoRecord> {
    return this.db
      .insertInto("assetPhotos")
      .values({
        tenantId: input.tenantId,
        assetId: input.assetId,
        objectKey: input.objectKey,
        contentType: input.contentType,
        createdByUserId: input.createdByUserId,
      })
      .returning(["id", "assetId", "objectKey", "contentType"])
      .executeTakeFirstOrThrow();
  }

  async listForAsset(assetId: string): Promise<readonly AssetPhotoRecord[]> {
    return this.db
      .selectFrom("assetPhotos")
      .select(["id", "assetId", "objectKey", "contentType"])
      .where("assetId", "=", assetId)
      .orderBy("createdAt", "asc")
      .execute();
  }

  async findForAsset(photoId: string, assetId: string): Promise<AssetPhotoRecord | undefined> {
    return this.db
      .selectFrom("assetPhotos")
      .select(["id", "assetId", "objectKey", "contentType"])
      .where("id", "=", photoId)
      .where("assetId", "=", assetId)
      .executeTakeFirst();
  }
}
