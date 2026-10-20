import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface DeviceRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly platform: string;
  readonly revokedAt: Date | null;
}

export class DeviceRepository {
  constructor(private readonly db: Transaction<Database>) {}

  /** Binds a device to a user; re-binding the same device reactivates it. */
  async bind(input: {
    tenantId: string;
    userId: string;
    deviceId: string;
    platform: string;
  }): Promise<DeviceRecord> {
    return this.db
      .insertInto("devices")
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        deviceId: input.deviceId,
        platform: input.platform,
      })
      .onConflict((oc) =>
        oc.columns(["tenantId", "userId", "deviceId"]).doUpdateSet({
          platform: input.platform,
          revokedAt: null,
          lastSeenAt: new Date(),
        }),
      )
      .returning(["id", "deviceId", "platform", "revokedAt"])
      .executeTakeFirstOrThrow();
  }

  async findActive(input: {
    userId: string;
    deviceId: string;
  }): Promise<DeviceRecord | undefined> {
    return this.db
      .selectFrom("devices")
      .select(["id", "deviceId", "platform", "revokedAt"])
      .where("userId", "=", input.userId)
      .where("deviceId", "=", input.deviceId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
  }
}
