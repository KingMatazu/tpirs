import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export type SessionKind = "access" | "refresh";

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: SessionKind;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export class SessionRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    kind?: SessionKind;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    const row = await this.db
      .insertInto("sessions")
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        kind: input.kind ?? "access",
        expiresAt: input.expiresAt,
      })
      .returning(["id", "userId", "kind", "expiresAt", "revokedAt"])
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      userId: row.userId,
      kind: row.kind as SessionKind,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined> {
    const row = await this.db
      .selectFrom("sessions")
      .select(["id", "userId", "kind", "expiresAt", "revokedAt"])
      .where("tokenHash", "=", tokenHash)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      userId: row.userId,
      kind: row.kind as SessionKind,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  /**
   * Idempotent: revoking an unknown or already-revoked session succeeds.
   * Returns true only when this call actually revoked an active row, which is
   * what makes refresh rotation single-use rather than last-writer-wins.
   */
  async revoke(tokenHash: string): Promise<boolean> {
    const result = await this.db
      .updateTable("sessions")
      .set({ revokedAt: new Date() })
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
