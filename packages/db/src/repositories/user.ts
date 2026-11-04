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
  /** The zone a supervisor is responsible for; null for everyone else. */
  readonly zoneId: string | null;
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
  /** Set for a zone supervisor; the service decides when it is required. */
  readonly zoneId?: string | null;
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
  "zoneId",
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
        zoneId: input.zoneId ?? null,
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
   * The oldest account holding a role, used to identify the administrator who
   * created the tenant when nobody can sign in to say so.
   *
   * Ordering by `created_at` rather than by name is the whole point: the
   * provisioning account is the first row the tenant ever had, whatever it was
   * later renamed to.
   */
  async findEarliestWithRole(roleKey: string): Promise<UserRecord | undefined> {
    const found = await this.db
      .selectFrom("userRoles")
      .innerJoin("roles", "roles.id", "userRoles.roleId")
      .innerJoin("users", "users.id", "userRoles.userId")
      .select("users.id")
      .where("roles.key", "=", roleKey)
      .orderBy("users.createdAt")
      .limit(1)
      .executeTakeFirst();
    return found === undefined ? undefined : await this.findById(found.id);
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
    input: {
      displayName?: string;
      status?: "active" | "disabled";
      /** `null` clears the zone, for an account that is no longer a supervisor. */
      zoneId?: string | null;
    },
  ): Promise<UserRecord | undefined> {
    const changes: {
      displayName?: string;
      status?: string;
      zoneId?: string | null;
      updatedAt: Date;
    } = {
      updatedAt: new Date(),
    };
    if (input.displayName !== undefined) changes.displayName = input.displayName;
    if (input.status !== undefined) changes.status = input.status;
    if (input.zoneId !== undefined) changes.zoneId = input.zoneId;
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
