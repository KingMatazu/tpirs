import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export class ScanRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async insertIfAbsent(input: {
    tenantId: string;
    assetId: string;
    officerUserId: string;
    deviceId: string;
    clientScanId: string;
    source: "qr" | "manual" | "offline_queue";
    observedStatus: string;
    authoritativeStatus: string;
    businessDate: string;
    scannedAt: Date;
    latitude?: number | null;
    longitude?: number | null;
    zoneId?: string | null;
  }) {
    const row = await this.db
      .insertInto("scans")
      .values({
        tenantId: input.tenantId,
        assetId: input.assetId,
        officerUserId: input.officerUserId,
        deviceId: input.deviceId,
        clientScanId: input.clientScanId,
        source: input.source,
        observedStatus: input.observedStatus,
        authoritativeStatus: input.authoritativeStatus,
        businessDate: input.businessDate,
        scannedAt: input.scannedAt,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        zoneId: input.zoneId ?? null,
      })
      .onConflict((oc) => oc.columns(["tenantId", "clientScanId"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return row;
    return this.db
      .selectFrom("scans")
      .selectAll()
      .where("tenantId", "=", input.tenantId)
      .where("clientScanId", "=", input.clientScanId)
      .executeTakeFirst();
  }

  async list(
    tenantId: string,
    filter: { officerUserId?: string; cursor?: string; limit?: number },
  ) {
    const limit = filter.limit ?? 50;
    let query = this.db.selectFrom("scans").selectAll().where("tenantId", "=", tenantId);
    if (filter.officerUserId !== undefined)
      query = query.where("officerUserId", "=", filter.officerUserId);
    if (filter.cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(filter.cursor, "base64url").toString("utf8")) as {
          scannedAt?: string;
          id?: string;
        };
        if (typeof decoded.scannedAt === "string" && typeof decoded.id === "string") {
          const ts = new Date(decoded.scannedAt);
          const scanId = decoded.id;
          if (!Number.isNaN(ts.getTime())) {
            query = query.where((eb) =>
              eb.or([
                eb("scannedAt", "<", ts),
                eb.and([eb("scannedAt", "=", ts), eb("id", "<", scanId)]),
              ]),
            );
          }
        }
      } catch {
        // ignore invalid cursor
      }
    }
    const rows = await query
      .orderBy("scannedAt", "desc")
      .orderBy("id", "desc")
      .limit(limit + 1)
      .execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? Buffer.from(
            JSON.stringify({ scannedAt: last.scannedAt.toISOString(), id: last.id }),
          ).toString("base64url")
        : null;
    return { rows: page, nextCursor, hasMore };
  }
}
