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
}

export type TenantRow = Selectable<TenantTable>;
export type ZoneRow = Selectable<ZoneTable>;
export type UserRow = Selectable<UserTable>;
export type RoleRow = Selectable<RoleTable>;
export type DeviceRow = Selectable<DeviceTable>;
export type SessionRow = Selectable<SessionTable>;
export type AuditLogRow = Selectable<AuditLogTable>;

export interface DbOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

/** The untyped-ish handle repositories accept; table interfaces live in `Database`. */
export type AnyDb = Kysely<Database>;

export function createDb(options: DbOptions): AnyDb {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
