import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface ZoneRecord {
  readonly id: string;
  readonly parentZoneId: string | null;
  readonly name: string;
}

export class ZoneRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: {
    tenantId: string;
    parentZoneId: string | null;
    name: string;
  }): Promise<ZoneRecord> {
    return this.db
      .insertInto("zones")
      .values({
        tenantId: input.tenantId,
        parentZoneId: input.parentZoneId,
        name: input.name,
      })
      .returning(["id", "parentZoneId", "name"])
      .executeTakeFirstOrThrow();
  }

  async list(): Promise<readonly ZoneRecord[]> {
    return this.db
      .selectFrom("zones")
      .select(["id", "parentZoneId", "name"])
      .orderBy("name")
      .execute();
  }

  async findById(id: string): Promise<ZoneRecord | undefined> {
    return this.db
      .selectFrom("zones")
      .select(["id", "parentZoneId", "name"])
      .where("id", "=", id)
      .executeTakeFirst();
  }
}
