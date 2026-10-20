import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export class SessionRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    return this.db
      .insertInto("sessions")
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning(["id", "userId", "expiresAt", "revokedAt"])
      .executeTakeFirstOrThrow();
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined> {
    return this.db
      .selectFrom("sessions")
      .select(["id", "userId", "expiresAt", "revokedAt"])
      .where("tokenHash", "=", tokenHash)
      .executeTakeFirst();
  }

  /** Idempotent: revoking an unknown or already-revoked session succeeds. */
  async revoke(tokenHash: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ revokedAt: new Date() })
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .execute();
  }
}
