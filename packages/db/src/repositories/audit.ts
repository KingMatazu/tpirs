import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface AuditEntryInput {
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly requestId?: string | null;
  readonly ip?: string | null;
}

export interface AuditSearchFilter {
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorUserId?: string;
  readonly limit?: number;
}

export interface AuditEntryRow {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorUserId: string | null;
  readonly beforeData: unknown;
  readonly afterData: unknown;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly createdAt: Date;
}

export interface AuditListFilter {
  readonly action?: string;
  /** The entity kind (asset, payment, user, ...). */
  readonly kind?: string;
  readonly actorUserId?: string;
  readonly from?: Date;
  readonly to?: Date;
  /** Opaque cursor from the previous page. */
  readonly cursor?: { readonly createdAt: Date; readonly id: string };
  readonly limit?: number;
}

/**
 * Audit entries are append-only: this repository offers only insert and reads.
 * Update and delete are additionally rejected by a database trigger.
 */
export class AuditRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async record(entry: AuditEntryInput): Promise<void> {
    await this.db
      .insertInto("auditLog")
      .values({
        tenantId: entry.tenantId,
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        beforeData: entry.before ?? null,
        afterData: entry.after ?? null,
        requestId: entry.requestId ?? null,
        ip: entry.ip ?? null,
      })
      .execute();
  }

  async search(filter: AuditSearchFilter): Promise<
    readonly {
      id: string;
      action: string;
      entityType: string;
      entityId: string | null;
      actorUserId: string | null;
      createdAt: Date;
    }[]
  > {
    let query = this.db
      .selectFrom("auditLog")
      .select(["id", "action", "entityType", "entityId", "actorUserId", "createdAt"])
      .orderBy("createdAt", "desc")
      .limit(filter.limit ?? 50);
    if (filter.action !== undefined) query = query.where("action", "=", filter.action);
    if (filter.entityType !== undefined) query = query.where("entityType", "=", filter.entityType);
    if (filter.entityId !== undefined) query = query.where("entityId", "=", filter.entityId);
    if (filter.actorUserId !== undefined) {
      query = query.where("actorUserId", "=", filter.actorUserId);
    }
    return query.execute();
  }

  /**
   * Cursor-paginated listing for the audit screen. Order is newest-first with
   * `id` as the deterministic tiebreaker; the cursor carries the last page's
   * (createdAt, id) pair so paging is stable while rows keep being appended.
   */
  async list(filter: AuditListFilter): Promise<readonly AuditEntryRow[]> {
    let query = this.db
      .selectFrom("auditLog")
      .select([
        "id",
        "action",
        "entityType",
        "entityId",
        "actorUserId",
        "beforeData",
        "afterData",
        "requestId",
        "ip",
        "createdAt",
      ])
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(filter.limit ?? 50);
    if (filter.action !== undefined) query = query.where("action", "=", filter.action);
    if (filter.kind !== undefined) query = query.where("entityType", "=", filter.kind);
    if (filter.actorUserId !== undefined) {
      query = query.where("actorUserId", "=", filter.actorUserId);
    }
    if (filter.from !== undefined) query = query.where("createdAt", ">=", filter.from);
    if (filter.to !== undefined) query = query.where("createdAt", "<=", filter.to);
    if (filter.cursor !== undefined) {
      const cursor = filter.cursor;
      query = query.where((eb) =>
        eb.or([
          eb("createdAt", "<", cursor.createdAt),
          eb.and([eb("createdAt", "=", cursor.createdAt), eb("id", "<", cursor.id)]),
        ]),
      );
    }
    return query.execute();
  }
}
