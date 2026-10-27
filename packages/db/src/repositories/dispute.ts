import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export class DisputeRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async createIfAbsent(input: {
    tenantId: string;
    assetId: string;
    openedByUserId: string;
    zoneId?: string | null;
    clientDisputeId: string;
    reason: string;
    description: string;
    occurredAt: Date;
    businessDate: string;
    latitude?: number | null;
    longitude?: number | null;
  }) {
    const row = await this.db
      .insertInto("disputes")
      .values({
        tenantId: input.tenantId,
        assetId: input.assetId,
        openedByUserId: input.openedByUserId,
        zoneId: input.zoneId ?? null,
        clientDisputeId: input.clientDisputeId,
        status: "open",
        reason: input.reason,
        description: input.description,
        occurredAt: input.occurredAt,
        businessDate: input.businessDate,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      })
      .onConflict((oc) => oc.columns(["tenantId", "clientDisputeId"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return row;
    return this.db
      .selectFrom("disputes")
      .selectAll()
      .where("tenantId", "=", input.tenantId)
      .where("clientDisputeId", "=", input.clientDisputeId)
      .executeTakeFirst();
  }

  async find(tenantId: string, id: string) {
    return this.db
      .selectFrom("disputes")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async list(
    tenantId: string,
    filter: { openedByUserId?: string; status?: string; cursor?: string; limit?: number },
  ) {
    const limit = filter.limit ?? 50;
    let query = this.db.selectFrom("disputes").selectAll().where("tenantId", "=", tenantId);
    if (filter.openedByUserId !== undefined)
      query = query.where("openedByUserId", "=", filter.openedByUserId);
    if (filter.status !== undefined) {
      const status = filter.status as "open" | "under_review" | "resolved" | "rejected";
      query = query.where("status", "=", status);
    }
    if (filter.cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(filter.cursor, "base64url").toString("utf8")) as {
          recordedAt?: string;
          id?: string;
        };
        if (typeof decoded.recordedAt === "string" && typeof decoded.id === "string") {
          const ts = new Date(decoded.recordedAt);
          const disputeId = decoded.id;
          if (!Number.isNaN(ts.getTime())) {
            query = query.where((eb) =>
              eb.or([
                eb("recordedAt", "<", ts),
                eb.and([eb("recordedAt", "=", ts), eb("id", "<", disputeId)]),
              ]),
            );
          }
        }
      } catch {
        // ignore invalid cursor
      }
    }
    const rows = await query
      .orderBy("recordedAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? Buffer.from(
            JSON.stringify({ recordedAt: last.recordedAt.toISOString(), id: last.id }),
          ).toString("base64url")
        : null;
    return { rows: page, nextCursor, hasMore };
  }

  async attachEvidence(input: {
    tenantId: string;
    disputeId: string;
    objectKey: string;
    contentType: string;
  }) {
    return this.db
      .insertInto("disputeEvidence")
      .values({
        tenantId: input.tenantId,
        disputeId: input.disputeId,
        objectKey: input.objectKey,
        contentType: input.contentType,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
