import { InvalidIdError } from "./errors.js";

declare const tenantSlugBrand: unique symbol;

/** A tenant slug: lowercase alphanumeric with hyphens, starting alphanumeric. */
export type TenantSlug = string & { readonly [tenantSlugBrand]: true };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function tenantSlug(value: string): TenantSlug {
  const trimmed = value.trim();
  if (!SLUG_PATTERN.test(trimmed)) {
    throw new InvalidIdError(
      "TenantSlug",
      `Tenant slug "${value}" must be lowercase alphanumeric with hyphens`,
    );
  }
  return trimmed as TenantSlug;
}

/**
 * Permission keys are data, not code. Roles are seeded per tenant from the
 * values a deployment declares, and guards check these keys only.
 */
export type Permission =
  | "tenant:read"
  | "tenant:configure"
  | "zone:read"
  | "zone:manage"
  | "user:read"
  | "user:manage"
  | "role:read"
  | "role:manage"
  | "asset:read"
  | "asset:manage"
  | "asset:create"
  | "payment:read"
  | "payment:manage"
  | "ledger:read"
  | "ledger:reverse"
  | "ledger:approve"
  | "dispute:read"
  | "dispute:create"
  | "dispute:resolve"
  | "scan:read"
  | "scan:record"
  | "cash:read"
  | "cash:intake"
  | "cash:deposit:read"
  | "cash:deposit:match"
  | "cash:freeze"
  | "cash:unfreeze"
  | "reconciliation:read"
  | "reconciliation:run"
  | "report:read"
  | "audit:read"
  | "audit:export";

export const ALL_PERMISSIONS: readonly Permission[] = [
  "tenant:read",
  "tenant:configure",
  "zone:read",
  "zone:manage",
  "user:read",
  "user:manage",
  "role:read",
  "role:manage",
  "asset:read",
  "asset:manage",
  "asset:create",
  "payment:read",
  "payment:manage",
  "ledger:read",
  "ledger:reverse",
  "ledger:approve",
  "dispute:read",
  "dispute:create",
  "dispute:resolve",
  "scan:read",
  "scan:record",
  "cash:read",
  "cash:intake",
  "cash:deposit:read",
  "cash:deposit:match",
  "cash:freeze",
  "cash:unfreeze",
  "reconciliation:read",
  "reconciliation:run",
  "report:read",
  "audit:read",
  "audit:export",
];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Built-in role keys. Custom roles are allowed; these are the ones every
 * deployment seeds so the platform is usable at onboarding.
 */
export type SystemRoleKey =
  | "driver"
  | "collector"
  | "officer"
  | "zone_supervisor"
  | "finance_admin"
  | "system_admin"
  | "auditor";

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly permissions: readonly Permission[];
}

/**
 * Default permission sets. Note system_admin may not touch ledger data
 * (build brief section 6); auditor is read-only.
 */
export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  { key: "driver", name: "Driver", permissions: [] },
  {
    key: "collector",
    name: "Collector",
    permissions: [
      "asset:read",
      "asset:manage",
      "payment:manage",
      "zone:read",
      "cash:read",
      "cash:intake",
    ],
  },
  {
    key: "officer",
    name: "Field Officer",
    permissions: [
      "asset:read",
      "dispute:read",
      "dispute:create",
      "scan:read",
      "scan:record",
      "zone:read",
    ],
  },
  {
    key: "zone_supervisor",
    name: "Zone Supervisor",
    permissions: [
      "asset:read",
      "asset:manage",
      "asset:create",
      "zone:read",
      "zone:manage",
      "report:read",
      "scan:read",
      "scan:record",
      "dispute:read",
      "dispute:create",
      "cash:read",
      "cash:intake",
      "cash:freeze",
    ],
  },
  {
    key: "finance_admin",
    name: "Finance Admin",
    permissions: [
      "payment:read",
      "payment:manage",
      "ledger:read",
      "ledger:reverse",
      "ledger:approve",
      "reconciliation:read",
      "reconciliation:run",
      "report:read",
      "dispute:read",
      "dispute:resolve",
      "scan:read",
      "cash:read",
      "cash:deposit:read",
      "cash:deposit:match",
      "cash:freeze",
      "cash:unfreeze",
    ],
  },
  {
    key: "system_admin",
    name: "System Admin",
    permissions: [
      "tenant:read",
      "tenant:configure",
      "zone:read",
      "zone:manage",
      "user:read",
      "user:manage",
      "role:read",
      "role:manage",
      "audit:read",
      // Operational *reads*. A system admin who cannot open the registry cannot
      // tell whether the deployment works, and the dashboard lands on a page they
      // are not allowed to see. Reading is not touching: every money-moving and
      // ledger permission stays out, which is the separation the brief requires.
      "asset:read",
      // Registering and correcting a vehicle is not money-moving, and the
      // dashboard's first job for a new deployment is putting drivers in the
      // register. The ledger stays closed.
      "asset:manage",
      "asset:create",
      "scan:read",
      "payment:read",
      "cash:read",
      "dispute:read",
      "report:read",
      "reconciliation:read",
    ],
  },
  {
    key: "auditor",
    name: "Auditor",
    permissions: [
      "tenant:read",
      "zone:read",
      "asset:read",
      "payment:read",
      "ledger:read",
      "dispute:read",
      "reconciliation:read",
      "report:read",
      "scan:read",
      "cash:read",
      "cash:deposit:read",
      "audit:read",
      "audit:export",
    ],
  },
];
