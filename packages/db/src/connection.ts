import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import type { ColumnType, Generated, Selectable } from "kysely";
import pg from "pg";

/** JSONB columns are parsed by pg into JS values; typed loosely at the row boundary. */
type Json = ColumnType<unknown, unknown, unknown>;
/** pg returns `Date` for timestamptz; inserts/updates accept a Date. */
type Timestamp = Date;

export interface TenantTable {
  id: Generated<string>;
  slug: string;
  name: string;
  legalEntity: string;
  config: Json;
  configVersion: Generated<number>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface ZoneTable {
  id: Generated<string>;
  tenantId: string;
  parentZoneId: string | null;
  name: string;
  createdAt: Generated<Timestamp>;
}

export interface UserTable {
  id: Generated<string>;
  tenantId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  totpSecret: string | null;
  status: Generated<string>;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface RoleTable {
  id: Generated<string>;
  tenantId: string;
  key: string;
  name: string;
  createdAt: Generated<Timestamp>;
}

export interface RolePermissionTable {
  roleId: string;
  tenantId: string;
  permission: string;
}

export interface UserRoleTable {
  userId: string;
  roleId: string;
  tenantId: string;
}

export interface DeviceTable {
  id: Generated<string>;
  tenantId: string;
  userId: string;
  deviceId: string;
  platform: string;
  boundAt: Generated<Timestamp>;
  lastSeenAt: Generated<Timestamp>;
  revokedAt: Timestamp | null;
}

export interface SessionTable {
  id: Generated<string>;
  tenantId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
}

export interface AuditLogTable {
  id: Generated<string>;
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeData: Json | null;
  afterData: Json | null;
  requestId: string | null;
  ip: string | null;
  createdAt: Generated<Timestamp>;
}

export interface OwnerTable {
  id: Generated<string>;
  tenantId: string;
  displayName: string;
  phone: string;
  phoneVerifiedAt: Timestamp | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface AssetTable {
  id: Generated<string>;
  tenantId: string;
  zoneId: string | null;
  ownerId: string | null;
  assetTypeKey: string;
  status: Generated<string>;
  attributes: Json;
  qrPayload: string;
  qrToken: string;
  shortCode: string;
  createdByUserId: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface AssetPhotoTable {
  id: Generated<string>;
  tenantId: string;
  assetId: string;
  objectKey: string;
  contentType: string;
  createdByUserId: string | null;
  createdAt: Generated<Timestamp>;
}

export interface AccountTable {
  id: Generated<string>;
  tenantId: string;
  code: string;
  name: string;
  accountType: string;
  accountClass: string;
  currency: string;
  metadata: Json;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface TransactionTable {
  id: Generated<string>;
  tenantId: string;
  idempotencyKey: string | null;
  sourceType: string;
  sourceId: string | null;
  description: string | null;
  postedAt: Generated<Timestamp>;
  createdByUserId: string | null;
  metadata: Json;
}

export interface LedgerEntryTable {
  id: Generated<string>;
  tenantId: string;
  transactionId: string;
  accountId: string;
  direction: "debit" | "credit";
  amountMinor: bigint;
  currency: string;
  assetId: string | null;
  paymentId: string | null;
  obligationPeriodId: string | null;
  memo: string | null;
  postedAt: Generated<Timestamp>;
  createdAt: Generated<Timestamp>;
}

export interface ObligationPeriodTable {
  id: Generated<string>;
  tenantId: string;
  assetId: string;
  periodKey: string;
  businessDate: string;
  status: "unpaid" | "paid" | "waived";
  amountMinor: bigint;
  amountPaidMinor: bigint;
  currency: string;
  feeRuleKey: string | null;
  feeAmountSnapshotMinor: bigint | null;
  paidTransactionId: string | null;
  priority: number;
  metadata: Json;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface ReversalRequestTable {
  id: Generated<string>;
  tenantId: string;
  originalTransactionId: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  requestedByUserId: string;
  approvedByUserId: string | null;
  rejectedByUserId: string | null;
  approvedAt: Timestamp | null;
  rejectedAt: Timestamp | null;
  expiresAt: Timestamp | null;
  reversingTransactionId: string | null;
  metadata: Json;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface Database {
  tenants: TenantTable;
  zones: ZoneTable;
  users: UserTable;
  roles: RoleTable;
  rolePermissions: RolePermissionTable;
  userRoles: UserRoleTable;
  devices: DeviceTable;
  sessions: SessionTable;
  auditLog: AuditLogTable;
  owners: OwnerTable;
  assets: AssetTable;
  assetPhotos: AssetPhotoTable;
  accounts: AccountTable;
  transactions: TransactionTable;
  ledgerEntries: LedgerEntryTable;
  obligationPeriods: ObligationPeriodTable;
  reversalRequests: ReversalRequestTable;
}

export type TenantRow = Selectable<TenantTable>;
export type ZoneRow = Selectable<ZoneTable>;
export type UserRow = Selectable<UserTable>;
export type RoleRow = Selectable<RoleTable>;
export type DeviceRow = Selectable<DeviceTable>;
export type SessionRow = Selectable<SessionTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type OwnerRow = Selectable<OwnerTable>;
export type AssetRow = Selectable<AssetTable>;
export type AssetPhotoRow = Selectable<AssetPhotoTable>;
export type AccountRow = Selectable<AccountTable>;
export type TransactionRow = Selectable<TransactionTable>;
export type LedgerEntryRow = Selectable<LedgerEntryTable>;
export type ObligationPeriodRow = Selectable<ObligationPeriodTable>;
export type ReversalRequestRow = Selectable<ReversalRequestTable>;

export interface DbOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

/** The untyped-ish handle repositories accept; table interfaces live in `Database`. */
export type AnyDb = Kysely<Database>;
export type Db = Kysely<Database>;
export type { Transaction } from "kysely";
export type DbOrTrx = Kysely<Database>;

export function createDb(options: DbOptions): AnyDb {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    // Tenant asset attributes are tenant-defined keys (e.g. `plate_number`);
    // they must round-trip unchanged, so leave nested JSON object keys alone.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
}
