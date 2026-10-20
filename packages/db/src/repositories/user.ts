import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly totpSecret: string | null;
  readonly passwordHash: string;
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly totpSecret: string | null;
}

export class UserRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: CreateUserInput): Promise<UserRecord> {
    return this.db
      .insertInto("users")
      .values({
        tenantId: input.tenantId,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        totpSecret: input.totpSecret,
      })
      .returning(["id", "username", "displayName", "status", "totpSecret", "passwordHash"])
      .executeTakeFirstOrThrow();
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    return this.db
      .selectFrom("users")
      .select(["id", "username", "displayName", "status", "totpSecret", "passwordHash"])
      .where("username", "=", username)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.db
      .selectFrom("users")
      .select(["id", "username", "displayName", "status", "totpSecret", "passwordHash"])
      .where("id", "=", id)
      .executeTakeFirst();
  }
}
