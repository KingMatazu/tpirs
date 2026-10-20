import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface OwnerRecord {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string;
  readonly phoneVerifiedAt: Date | null;
}

export interface CreateOwnerInput {
  readonly tenantId: string;
  readonly displayName: string;
  readonly phone: string;
}

export class OwnerRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: CreateOwnerInput): Promise<OwnerRecord> {
    return this.db
      .insertInto("owners")
      .values({
        tenantId: input.tenantId,
        displayName: input.displayName,
        phone: input.phone,
      })
      .returning(["id", "displayName", "phone", "phoneVerifiedAt"])
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<OwnerRecord | undefined> {
    return this.db
      .selectFrom("owners")
      .select(["id", "displayName", "phone", "phoneVerifiedAt"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async findByPhone(phone: string): Promise<OwnerRecord | undefined> {
    return this.db
      .selectFrom("owners")
      .select(["id", "displayName", "phone", "phoneVerifiedAt"])
      .where("phone", "=", phone)
      .executeTakeFirst();
  }

  /** Marks the phone verified (idempotent); returns the updated owner. */
  async markPhoneVerified(id: string): Promise<OwnerRecord> {
    return this.db
      .updateTable("owners")
      .set({ phoneVerifiedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .returning(["id", "displayName", "phone", "phoneVerifiedAt"])
      .executeTakeFirstOrThrow();
  }
}
