import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_ROLES } from "@tpirs/domain";
import type { Permission } from "@tpirs/domain";

/**
 * Route × role access matrix (Phase 10, Step 5).
 *
 * Two things are proven here without a database:
 *
 * 1. **Completeness.** Every route registered in `src/routes` is either public
 *    by design, authenticated without a permission (`/v1/auth/me`), or listed in
 *    the matrix with the permission it must demand. A new route that forgets to
 *    appear fails this test — the matrix cannot fall behind the surface.
 * 2. **Role sanity.** The default permission sets in `@tpirs/domain` still mean
 *    what the brief says: `system_admin` cannot touch the ledger, `auditor` is
 *    read-only, and no role holds a permission the matrix never names.
 *
 * Enforcement at request time is covered by each route's own tests; this matrix
 * is the guard for which permission a route is *supposed* to require, and the
 * tripwire for a route added without one.
 */

const routesDir = path.resolve(import.meta.dirname);

/** Unauthenticated by design. The reason is part of the entry, on purpose. */
const PUBLIC: Readonly<Record<string, string>> = {
  "POST /v1/auth/login": "sign-in, before a session exists",
  "POST /v1/auth/refresh": "cookie-only refresh (ADR 0026)",
  "POST /v1/auth/logout": "revokes whatever session the caller presents",
  "GET /v1/verify/:token": "public sticker verification (ADR 0007), rate limited",
  "POST /webhooks/:provider/:endpointToken": "provider callback, endpoint token (ADR 0017)",
  "POST /webhooks/ussd/:provider/:endpointToken": "USSD callback, endpoint token",
  "POST /webhooks/sms/:provider/:endpointToken": "inbound SMS callback, endpoint token",
};

/** Authenticated, but about the caller's own session: no permission applies. */
const AUTHENTICATED: Readonly<Record<string, string>> = {
  "GET /v1/auth/me": "the caller's own session and permissions",
  // Name, branding and locale: every signed-in role renders the shell with them,
  // and none of it is the full config (which stays behind tenant:read).
  "GET /v1/tenants/current/branding": "the shell's branding projection",
};

/** The permission each protected route must demand, keyed by `METHOD path`. */
const REQUIRED: Readonly<Record<string, readonly Permission[]>> = {
  "POST /v1/assets": ["asset:manage"],
  "GET /v1/assets": ["asset:read"],
  "GET /v1/assets/:id": ["asset:read"],
  "PATCH /v1/assets/:id": ["asset:manage"],
  "POST /v1/assets/:id/photos": ["asset:manage"],
  "GET /v1/assets/:id/photos/:photoId": ["asset:read"],
  "GET /v1/assets/:id/sticker": ["asset:read"],
  "POST /v1/assets/:id/suspend": ["asset:manage"],
  "POST /v1/owners": ["asset:manage"],
  "GET /v1/owners/:id": ["asset:read"],
  "POST /v1/owners/verify/request": ["asset:manage"],
  "POST /v1/owners/verify/confirm": ["asset:manage"],
  "GET /v1/audit": ["audit:read"],
  "POST /v1/cash/intakes": ["cash:intake"],
  "POST /v1/cash/intakes/:id/reverse": ["payment:manage"],
  "GET /v1/cash/wallets": ["cash:read"],
  "GET /v1/cash/wallets/:collectorUserId": ["cash:read"],
  "POST /v1/cash/collectors/:collectorUserId/deposit-instruction": ["payment:manage"],
  "GET /v1/cash/deposits": ["cash:deposit:read"],
  "POST /v1/cash/deposits/:id/match": ["cash:deposit:match"],
  "GET /v1/tenants/current/config": ["tenant:read"],
  "PUT /v1/tenants/current/config": ["tenant:configure"],
  "GET /v1/verifications/search": ["asset:read"],
  "GET /v1/sync/paid": ["asset:read"],
  "POST /v1/scans": ["scan:record"],
  "GET /v1/scans": ["scan:read"],
  "POST /v1/disputes": ["dispute:create"],
  "GET /v1/disputes": ["dispute:read"],
  "GET /v1/disputes/:id": ["dispute:read"],
  "GET /v1/payments": ["payment:read"],
  "GET /v1/payments/suspense": ["payment:read"],
  "GET /v1/payments/:id/outbox": ["payment:read"],
  "POST /v1/payments/:id/resolve": ["payment:manage"],
  "POST /v1/settlements/import": ["reconciliation:run"],
  "GET /v1/reconciliation/runs": ["reconciliation:read"],
  "GET /v1/reconciliation/runs/:id": ["reconciliation:read"],
  "POST /v1/reconciliation/runs/:id/sign-off": ["reconciliation:run"],
  "GET /v1/reconciliation/exceptions": ["reconciliation:read"],
  "GET /v1/anomalies": ["reconciliation:read"],
  "POST /v1/anomalies/:id/acknowledge": ["reconciliation:run"],
  "GET /v1/reports/:key": ["report:read"],
  "GET /v1/reports/:key/export": ["report:read"],
  "GET /v1/reversals": ["ledger:read"],
  "POST /v1/reversals/:id/approve": ["ledger:approve"],
  "POST /v1/reversals/:id/reject": ["ledger:approve"],
};

/**
 * Routes registered in a loop, where the path is a variable rather than a
 * literal. The source scan cannot see them, so they are asserted by their file
 * containing both the path template and the permission.
 */
const DYNAMIC: readonly { key: string; file: string; path: string; permission: Permission }[] = [
  {
    key: "POST /v1/cash/wallets/:collectorUserId/freeze",
    file: "cash.ts",
    path: "/v1/cash/wallets/:collectorUserId/freeze",
    permission: "cash:freeze",
  },
  {
    key: "POST /v1/cash/wallets/:collectorUserId/unfreeze",
    file: "cash.ts",
    path: "/v1/cash/wallets/:collectorUserId/unfreeze",
    permission: "cash:unfreeze",
  },
  {
    key: "POST /v1/reconciliation/exceptions/:id/resolve",
    file: "reconciliation.ts",
    path: "/v1/reconciliation/exceptions/",
    permission: "reconciliation:run",
  },
];

interface RegisteredRoute {
  readonly key: string;
  readonly file: string;
  readonly permissions: readonly string[];
}

const LITERAL_ROUTE = /\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*"([^"]+)"/g;
const ROUTE_BOUNDARY = /\bapp\.(get|post|put|patch|delete)\b/g;
const PERMISSION_CALL = /requirePermission\(\s*request\s*,\s*"([^"]+)"/g;

function sources(): { file: string; text: string }[] {
  return readdirSync(routesDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ file, text: readFileSync(path.join(routesDir, file), "utf8") }));
}

function scanRoutes(): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const { file, text } of sources()) {
    const boundaries = [...text.matchAll(ROUTE_BOUNDARY)].map((match) => match.index ?? 0);
    for (const match of text.matchAll(LITERAL_ROUTE)) {
      const start = match.index ?? 0;
      // Stop at the next route registration of any shape, so a loop-registered
      // neighbour's permission is never attributed to this route.
      const end = boundaries.find((boundary) => boundary > start) ?? text.length;
      const permissions = [...text.slice(start, end).matchAll(PERMISSION_CALL)].map(
        (found) => found[1] ?? "",
      );
      routes.push({
        key: `${(match[1] ?? "").toUpperCase()} ${match[2] ?? ""}`,
        file,
        permissions: [...new Set(permissions)],
      });
    }
  }
  return routes;
}

const registered = scanRoutes();
const byKey = new Map(registered.map((route) => [route.key, route]));

describe("route access matrix", () => {
  it("finds the route surface (the scan must not silently return nothing)", () => {
    expect(registered.length).toBeGreaterThan(45);
  });

  it("classifies every registered route as public, authenticated or permissioned", () => {
    const unclassified = registered
      .filter((route) => !(route.key in PUBLIC) && !(route.key in AUTHENTICATED))
      .filter((route) => !(route.key in REQUIRED))
      .map((route) => `${route.key} (${route.file})`);
    expect(unclassified).toEqual([]);
  });

  it("requires exactly the permissions the matrix names", () => {
    const mismatches: string[] = [];
    for (const [key, expected] of Object.entries(REQUIRED)) {
      const route = byKey.get(key);
      if (route === undefined) continue; // covered by the stale-entry test
      const actual = [...route.permissions].sort();
      if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
        mismatches.push(`${key}: expected ${String(expected)}, saw ${String(actual)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps no stale entries for routes that no longer exist", () => {
    const stale = [...Object.keys(REQUIRED), ...Object.keys(PUBLIC), ...Object.keys(AUTHENTICATED)]
      .filter((key) => !byKey.has(key))
      .filter((key) => !DYNAMIC.some((dynamic) => dynamic.key === key));
    expect(stale).toEqual([]);
  });

  it("keeps public and session routes free of a permission check", () => {
    const leaky = registered
      .filter((route) => route.key in PUBLIC || route.key in AUTHENTICATED)
      .filter((route) => route.permissions.length > 0)
      .map((route) => `${route.key}: ${String(route.permissions)}`);
    expect(leaky).toEqual([]);
  });

  it("gives every loop-registered route its permission", () => {
    const missing: string[] = [];
    for (const dynamic of DYNAMIC) {
      const source = sources().find((entry) => entry.file === dynamic.file);
      if (source === undefined || !source.text.includes(dynamic.path)) {
        missing.push(`${dynamic.key}: path template not found in ${dynamic.file}`);
        continue;
      }
      if (!source.text.includes(`"${dynamic.permission}"`)) {
        missing.push(`${dynamic.key}: ${dynamic.permission} not found in ${dynamic.file}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("role defaults", () => {
  const role = (key: string): Set<string> =>
    new Set(SYSTEM_ROLES.find((entry) => entry.key === key)?.permissions ?? []);

  it("gives system_admin no ledger or money-moving permission", () => {
    const admin = role("system_admin");
    for (const forbidden of ["ledger:read", "ledger:reverse", "ledger:approve", "payment:manage"]) {
      expect(admin.has(forbidden)).toBe(false);
    }
  });

  it("keeps the auditor read-only", () => {
    const writes = [...role("auditor")].filter(
      (permission) => !permission.endsWith(":read") && !permission.endsWith(":export"),
    );
    expect(writes).toEqual([]);
  });

  it("gives the officer no money-moving permission", () => {
    const officer = role("officer");
    for (const forbidden of ["payment:manage", "cash:intake", "ledger:approve"]) {
      expect(officer.has(forbidden)).toBe(false);
    }
  });

  it("gives every matrix permission to at least one role", () => {
    const held = new Set<string>();
    for (const entry of SYSTEM_ROLES)
      for (const permission of entry.permissions) held.add(permission);
    const orphans = new Set(
      Object.values(REQUIRED)
        .flat()
        .filter((permission) => !held.has(permission)),
    );
    expect([...orphans]).toEqual([]);
  });
});
