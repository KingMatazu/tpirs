import type { Transaction } from "kysely";
import type { Database } from "../connection.js";

export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalEntity: string;
  readonly config: unknown;
  readonly configVersion: number;
}

export interface CreateTenantInput {
  readonly slug: string;
  readonly name: string;
  readonly legalEntity: string;
  readonly config: unknown;
}

/**
 * Tenant reads/writes. Provisioning crosses tenant boundaries (a new tenant is
 * created before any tenant scope exists), so this runs with system privileges;
 * per-tenant config updates run in a tenant scope via withTenant.
 */
export class TenantRepository {
  constructor(private readonly db: Transaction<Database>) {}

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    return this.db
      .insertInto("tenants")
      .values({
        slug: input.slug,
        name: input.name,
        legalEntity: input.legalEntity,
        config: input.config,
      })
      .returning(["id", "slug", "name", "legalEntity", "config", "configVersion"])
      .executeTakeFirstOrThrow();
  }

  async findById(id: string): Promise<TenantRecord | undefined> {
    return this.db
      .selectFrom("tenants")
      .select(["id", "slug", "name", "legalEntity", "config", "configVersion"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async findBySlug(slug: string): Promise<TenantRecord | undefined> {
    return this.db
      .selectFrom("tenants")
      .select(["id", "slug", "name", "legalEntity", "config", "configVersion"])
      .where("slug", "=", slug)
      .executeTakeFirst();
  }

  async list(): Promise<readonly TenantRecord[]> {
    return this.db
      .selectFrom("tenants")
      .select(["id", "slug", "name", "legalEntity", "config", "configVersion"])
      .orderBy("slug")
      .execute();
  }

  /** Replaces the config and bumps its version exactly once. */
  async updateConfig(id: string, config: unknown): Promise<TenantRecord> {
    return this.db
      .updateTable("tenants")
      .set((eb) => ({
        config,
        configVersion: eb("configVersion", "+", 1),
        updatedAt: new Date(),
      }))
      .where("id", "=", id)
      .returning(["id", "slug", "name", "legalEntity", "config", "configVersion"])
      .executeTakeFirstOrThrow();
  }
}
