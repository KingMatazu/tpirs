import type { AnyDb } from "@tpirs/db";
import { repositories, withTenant } from "@tpirs/db";
import type { TenantConfig } from "@tpirs/config";

export interface SyncPaidSetDeps {
  readonly db: AnyDb;
  readonly loadConfig: (tenantId: string) => Promise<TenantConfig | undefined>;
  readonly now?: () => Date;
}

export interface PaidSetEntry {
  readonly assetId: string;
  readonly qrPayload: string;
  readonly shortCode: string;
  readonly assetTypeKey: string;
  readonly attributes: Record<string, unknown>;
  readonly paid: boolean;
  readonly changedAt: string;
}

export interface PaidSetCursor {
  readonly updatedAt: string;
  readonly id: string;
}

export interface PaidSetDelta {
  readonly mode: "snapshot" | "delta";
  readonly businessDate: string;
  readonly entries: readonly PaidSetEntry[];
  /**
   * Opaque cursor for the last row of this page, or null when the page is empty.
   * It is returned even when `hasMore` is false so the client can keep it and ask
   * for a *delta* next time instead of downloading the whole day again.
   */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly serverTime: string;
}

function encodeCursor(cursor: PaidSetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(raw: string): PaidSetCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const updatedAt = (parsed as { updatedAt?: unknown }).updatedAt;
    const id = (parsed as { id?: unknown }).id;
    if (typeof updatedAt !== "string" || typeof id !== "string") return undefined;
    return { updatedAt, id };
  } catch {
    return undefined;
  }
}

export class PaidSetSyncService {
  constructor(private readonly deps: SyncPaidSetDeps) {}

  async sync(
    tenantId: string,
    params: { since?: string; limit?: number },
  ): Promise<PaidSetDelta | { error: "not_found" }> {
    const config = await this.deps.loadConfig(tenantId);
    if (config === undefined) return { error: "not_found" };
    if (!config.featureFlags.offlineMode) return { error: "not_found" };
    const now = this.deps.now?.() ?? new Date();
    const { todayInTimeZone } = await import("@tpirs/domain");
    const businessDate = todayInTimeZone(config.locale.timezone, now);
    const limit = Math.min(params.limit ?? 500, 1000);

    let cursor: { updatedAt: Date; id: string } | undefined;
    if (params.since !== undefined) {
      const decoded = decodeCursor(params.since);
      if (decoded !== undefined) {
        const updatedAt = new Date(decoded.updatedAt);
        if (!Number.isNaN(updatedAt.getTime())) cursor = { updatedAt, id: decoded.id };
      }
    }
    const mode = cursor === undefined ? "snapshot" : "delta";

    const periods = await withTenant(this.deps.db, tenantId, async (tx) => {
      const rows = await repositories(tx).obligations.listForBusinessDateSince(
        tenantId,
        businessDate,
        cursor,
        limit + 1,
      );
      const assets = new Map<
        string,
        {
          qrPayload: string;
          shortCode: string;
          assetTypeKey: string;
          attributes: Record<string, unknown>;
        }
      >();
      for (const row of rows) {
        if (assets.has(row.assetId)) continue;
        const asset = await repositories(tx).assets.findById(row.assetId);
        if (asset !== undefined) {
          assets.set(row.assetId, {
            qrPayload: asset.qrPayload,
            shortCode: asset.shortCode,
            assetTypeKey: asset.assetTypeKey,
            attributes: asset.attributes,
          });
        }
      }
      return { rows, assets };
    });

    const hasMore = periods.rows.length > limit;
    const page = hasMore ? periods.rows.slice(0, limit) : periods.rows;
    const entries: PaidSetEntry[] = [];
    for (const row of page) {
      const asset = periods.assets.get(row.assetId);
      if (asset === undefined) continue;
      const paid = row.status === "paid" || row.status === "waived";
      entries.push({
        assetId: row.assetId,
        qrPayload: asset.qrPayload,
        shortCode: asset.shortCode,
        assetTypeKey: asset.assetTypeKey,
        attributes: asset.attributes,
        paid,
        changedAt: row.updatedAt.toISOString(),
      });
    }

    const last = page[page.length - 1];
    // Encoded here, not by the route: the wire type is a string (the client sends
    // it back as `?since=`), and a raw object would serialize as "[object Object]"
    // — every delta would then decode to nothing and silently become a snapshot.
    const nextCursor =
      last === undefined
        ? null
        : encodeCursor({ updatedAt: last.updatedAt.toISOString(), id: last.id });
    return {
      mode,
      businessDate,
      entries,
      nextCursor,
      hasMore,
      serverTime: now.toISOString(),
    };
  }
}

export function createPaidSetSyncService(deps: SyncPaidSetDeps): PaidSetSyncService {
  return new PaidSetSyncService(deps);
}

export { encodeCursor as encodePaidSetCursor, decodeCursor as decodePaidSetCursor };
