import { repositories, withTenant } from "@tpirs/db";
import type { AnyDb, OwnerRecord } from "@tpirs/db";

export interface OwnerServiceDeps {
  readonly db: AnyDb;
}

export interface CreateOwnerInput {
  readonly tenantId: string;
  readonly displayName: string;
  readonly phone: string;
}

/**
 * Owner registry. Owners are the natural persons or businesses accountable for
 * an asset; phone verification happens through the OTP service before an owner
 * is marked verified.
 */
export function createOwnerService(deps: OwnerServiceDeps) {
  async function create(input: CreateOwnerInput): Promise<OwnerRecord> {
    return withTenant(deps.db, input.tenantId, async (tx) =>
      repositories(tx).owners.create({
        tenantId: input.tenantId,
        displayName: input.displayName,
        phone: input.phone,
      }),
    );
  }

  async function findById(tenantId: string, ownerId: string): Promise<OwnerRecord | undefined> {
    return withTenant(deps.db, tenantId, async (tx) => repositories(tx).owners.findById(ownerId));
  }

  async function findByPhone(tenantId: string, phone: string): Promise<OwnerRecord | undefined> {
    return withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).owners.findByPhone(phone.trim()),
    );
  }

  async function markPhoneVerified(tenantId: string, ownerId: string): Promise<OwnerRecord> {
    return withTenant(deps.db, tenantId, async (tx) =>
      repositories(tx).owners.markPhoneVerified(ownerId),
    );
  }

  return { create, findById, findByPhone, markPhoneVerified };
}

export type OwnerService = ReturnType<typeof createOwnerService>;
