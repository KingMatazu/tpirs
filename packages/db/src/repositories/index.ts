import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import { AuditRepository } from "./audit.js";
import { DeviceRepository } from "./device.js";
import { RoleRepository } from "./role.js";
import { SessionRepository } from "./session.js";
import { TenantRepository } from "./tenant.js";
import { UserRepository } from "./user.js";
import { ZoneRepository } from "./zone.js";

export * from "./audit.js";
export * from "./device.js";
export * from "./role.js";
export * from "./session.js";
export * from "./tenant.js";
export * from "./user.js";
export * from "./zone.js";

/** Bundles every repository over one transaction, so callers share a scope. */
export function repositories(db: Transaction<Database>): {
  tenants: TenantRepository;
  zones: ZoneRepository;
  users: UserRepository;
  roles: RoleRepository;
  devices: DeviceRepository;
  sessions: SessionRepository;
  audit: AuditRepository;
} {
  return {
    tenants: new TenantRepository(db),
    zones: new ZoneRepository(db),
    users: new UserRepository(db),
    roles: new RoleRepository(db),
    devices: new DeviceRepository(db),
    sessions: new SessionRepository(db),
    audit: new AuditRepository(db),
  };
}
