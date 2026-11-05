import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface OwnerRecord {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string;
  /** Optional contact address; nothing sends to it yet (migration 0026). */
  readonly email: string | null;
  readonly phoneVerifiedAt: Date | null;
}

export interface CreateOwnerInput {
  readonly tenantId: string;
  readonly displayName: string;
  readonly phone: string;
  readonly email?: string | null;
}

const OWNER_COLUMNS = ["id", "displayName", "phone", "email", "phoneVerifiedAt"] as const;

export class OwnerRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: CreateOwnerInput): Promise<OwnerRecord> {
    return this.db
      .insertInto("owners")
      .values({
        tenantId: input.tenantId,
        displayName: input.displayName,
        phone: input.phone,
        email: input.email ?? null,
      })
      .returning(OWNER_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<OwnerRecord | undefined> {
    return this.db
      .selectFrom("owners")
      .select(OWNER_COLUMNS)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async findByPhone(phone: string): Promise<OwnerRecord | undefined> {
    return this.db
      .selectFrom("owners")
      .select(OWNER_COLUMNS)
      .where("phone", "=", phone)
      .executeTakeFirst();
  }

  /**
   * Display names for a set of owners, keyed by id.
   *
   * List screens show a person's name, never the opaque id: a registry clerk
   * reading "Owner: 7f3a…" learns nothing. One query for the whole page keeps
   * the asset list from turning into a lookup per row.
   */
  async namesByIds(ids: readonly string[]): Promise<Readonly<Record<string, string>>> {
    if (ids.length === 0) return {};
    const rows = await this.db
      .selectFrom("owners")
      .select(["id", "displayName"])
      .where("id", "in", [...ids])
      .execute();
    return Object.fromEntries(rows.map((row) => [row.id, row.displayName]));
  }

  /** Marks the phone verified (idempotent); returns the updated owner. */
  async markPhoneVerified(id: string): Promise<OwnerRecord> {
    return this.db
      .updateTable("owners")
      .set({ phoneVerifiedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", id)
      .returning(OWNER_COLUMNS)
      .executeTakeFirstOrThrow();
  }
}
