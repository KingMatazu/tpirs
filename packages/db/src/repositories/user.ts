import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface UserRecord {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly nationalId: string | null;
  readonly homeAddress: string | null;
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
  /** Contact and identity details; the API requires them for a collector only. */
  readonly phone?: string | null;
  readonly nationalId?: string | null;
  readonly homeAddress?: string | null;
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
  "phone",
  "nationalId",
  "homeAddress",
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
        phone: input.phone ?? null,
        nationalId: input.nationalId ?? null,
        homeAddress: input.homeAddress ?? null,
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

  /** Every account in the tenant, oldest name first. Tenant scope is RLS. */
  async list(): Promise<readonly UserRecord[]> {
    return this.db.selectFrom("users").select(USER_COLUMNS).orderBy("username").execute();
  }

  /**
   * Profile and status only. Credentials have their own method so a routine edit
   * can never accidentally rewrite a password hash, and the columns are named
   * individually rather than spread from input for the same reason.
   */
  async updateProfile(
    id: string,
    input: { displayName?: string; status?: "active" | "disabled" },
  ): Promise<UserRecord | undefined> {
    const changes: { displayName?: string; status?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (input.displayName !== undefined) changes.displayName = input.displayName;
    if (input.status !== undefined) changes.status = input.status;
    return this.db
      .updateTable("users")
      .set(changes)
      .where("id", "=", id)
      .returning(USER_COLUMNS)
      .executeTakeFirst();
  }

  /**
   * The owner of a flagged account replaces its temporary password. The username
   * is untouched: an administrator chose it, wrote it on the handover card and
   * the person has no reason to invent a different one. Clearing the flag in the
   * same statement is what makes the replacement atomic — a new password with the
   * old lock, or the reverse, is a state nobody can sign in from.
   */
  async changePassword(id: string, passwordHash: string): Promise<UserRecord | undefined> {
    return this.db
      .updateTable("users")
      .set({ passwordHash, mustChangeCredentials: false, updatedAt: new Date() })
      .where("id", "=", id)
      .returning(USER_COLUMNS)
      .executeTakeFirst();
  }

  /**
   * An administrator sets a temporary password, so the account is flagged: the
   * next sign-in reaches only the credential step, where the owner replaces it.
   * Setting the flag here (not in the route) keeps "new password" and "must
   * change it" from ever being written separately.
   */
  async setTemporaryPassword(id: string, passwordHash: string): Promise<UserRecord | undefined> {
    return this.db
      .updateTable("users")
      .set({ passwordHash, mustChangeCredentials: true, updatedAt: new Date() })
      .where("id", "=", id)
      .returning(USER_COLUMNS)
      .executeTakeFirst();
  }
}
