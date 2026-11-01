import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly status: string;
  readonly totpSecret: string | null;
  readonly passwordHash: string;
  readonly mustChangeCredentials: boolean;
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly totpSecret: string | null;
  readonly email?: string | null;
  /**
   * Set for an account created with a known temporary password: the session it
   * obtains may reach only the route that replaces that password.
   */
  readonly mustChangeCredentials?: boolean;
}

export interface UpdateCredentialsInput {
  readonly userId: string;
  readonly username: string;
  readonly passwordHash: string;
}

const USER_COLUMNS = [
  "id",
  "username",
  "displayName",
  "email",
  "status",
  "totpSecret",
  "passwordHash",
  "mustChangeCredentials",
] as const;

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
        email: input.email ?? null,
        mustChangeCredentials: input.mustChangeCredentials ?? false,
      })
      .returning(USER_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async findByUsername(username: string): Promise<UserRecord | undefined> {
    return this.db
      .selectFrom("users")
      .select(USER_COLUMNS)
      .where("username", "=", username)
      .executeTakeFirst();
  }

  /**
   * Usernames are unique per tenant, not globally, so a caller outside
   * row-level security (provisioning, which reserves the username it is about to
   * create) must name the tenant explicitly or it will find another state's user.
   */
  async findByUsernameInTenant(
    tenantId: string,
    username: string,
  ): Promise<UserRecord | undefined> {
    return this.db
      .selectFrom("users")
      .select(USER_COLUMNS)
      .where("tenantId", "=", tenantId)
      .where("username", "=", username)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    return this.db.selectFrom("users").select(USER_COLUMNS).where("id", "=", id).executeTakeFirst();
  }

  /**
   * Replaces the credentials of an account that is still holding provisioning
   * ones, and clears the flag in the same statement so the account can never be
   * left with a new password but a locked session (or the reverse).
   */
  async updateCredentials(input: UpdateCredentialsInput): Promise<UserRecord | undefined> {
    return this.db
      .updateTable("users")
      .set({
        username: input.username,
        passwordHash: input.passwordHash,
        mustChangeCredentials: false,
        updatedAt: new Date(),
      })
      .where("id", "=", input.userId)
      .returning(USER_COLUMNS)
      .executeTakeFirst();
  }
}
