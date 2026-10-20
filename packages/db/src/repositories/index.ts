import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import { AssetPhotoRepository } from "./asset-photo.js";
import { AssetRepository } from "./asset.js";
import { AuditRepository } from "./audit.js";
import { DeviceRepository } from "./device.js";
import { OwnerRepository } from "./owner.js";
import { RoleRepository } from "./role.js";
import { SessionRepository } from "./session.js";
import { TenantRepository } from "./tenant.js";
import { UserRepository } from "./user.js";
import { ZoneRepository } from "./zone.js";

export * from "./asset-photo.js";
export * from "./asset.js";
export * from "./audit.js";
export * from "./device.js";
export * from "./owner.js";
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
  owners: OwnerRepository;
  assets: AssetRepository;
  assetPhotos: AssetPhotoRepository;
} {
  return {
    tenants: new TenantRepository(db),
    zones: new ZoneRepository(db),
    users: new UserRepository(db),
    roles: new RoleRepository(db),
    devices: new DeviceRepository(db),
    sessions: new SessionRepository(db),
    audit: new AuditRepository(db),
    owners: new OwnerRepository(db),
    assets: new AssetRepository(db),
    assetPhotos: new AssetPhotoRepository(db),
  };
}
