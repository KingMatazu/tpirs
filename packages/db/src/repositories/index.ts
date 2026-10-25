import type { Transaction } from "kysely";
import type { Database } from "../connection.js";
import { AssetPhotoRepository } from "./asset-photo.js";
import { AssetRepository } from "./asset.js";
import { AuditRepository } from "./audit.js";
import { ChannelMessageRepository } from "./channel-messages.js";
import { DeviceRepository } from "./device.js";
import { DisputeRepository } from "./dispute.js";
import { OwnerRepository } from "./owner.js";
import { ScanRepository } from "./scan.js";
import {
  AccountRepository,
  LedgerRepository,
  ObligationRepository,
  ReversalRepository,
} from "./ledger.js";
import {
  PaymentInstructionRepository,
  PaymentRepository,
  SmsLogRepository,
  WebhookEndpointRepository,
  WebhookEventRepository,
} from "./payments.js";
import { RoleRepository } from "./role.js";
import { SessionRepository } from "./session.js";
import { TenantRepository } from "./tenant.js";
import { UserRepository } from "./user.js";
import { ZoneRepository } from "./zone.js";

export * from "./asset-photo.js";
export * from "./asset.js";
export * from "./audit.js";
export * from "./channel-messages.js";
export * from "./device.js";
export * from "./dispute.js";
export * from "./ledger.js";
export * from "./owner.js";
export * from "./payments.js";
export * from "./role.js";
export * from "./scan.js";
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
  channelMessages: ChannelMessageRepository;
  owners: OwnerRepository;
  assets: AssetRepository;
  assetPhotos: AssetPhotoRepository;
  accounts: AccountRepository;
  ledger: LedgerRepository;
  obligations: ObligationRepository;
  reversals: ReversalRepository;
  paymentInstructions: PaymentInstructionRepository;
  payments: PaymentRepository;
  webhookEvents: WebhookEventRepository;
  smsLog: SmsLogRepository;
  webhookEndpoints: WebhookEndpointRepository;
  scans: ScanRepository;
  disputes: DisputeRepository;
} {
  return {
    tenants: new TenantRepository(db),
    zones: new ZoneRepository(db),
    users: new UserRepository(db),
    roles: new RoleRepository(db),
    devices: new DeviceRepository(db),
    sessions: new SessionRepository(db),
    audit: new AuditRepository(db),
    channelMessages: new ChannelMessageRepository(db),
    owners: new OwnerRepository(db),
    assets: new AssetRepository(db),
    assetPhotos: new AssetPhotoRepository(db),
    accounts: new AccountRepository(db),
    ledger: new LedgerRepository(db),
    obligations: new ObligationRepository(db),
    reversals: new ReversalRepository(db),
    paymentInstructions: new PaymentInstructionRepository(db),
    payments: new PaymentRepository(db),
    webhookEvents: new WebhookEventRepository(db),
    smsLog: new SmsLogRepository(db),
    webhookEndpoints: new WebhookEndpointRepository(db),
    scans: new ScanRepository(db),
    disputes: new DisputeRepository(db),
  };
}
