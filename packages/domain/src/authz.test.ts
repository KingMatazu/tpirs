import { describe, expect, it } from "vitest";
import { ForbiddenError, assertPermission, can, principal } from "./authz.js";
import { SYSTEM_ROLES, isPermission } from "./tenancy.js";

describe("permission model", () => {
  it("recognizes valid permission keys and rejects unknown ones", () => {
    expect(isPermission("ledger:read")).toBe(true);
    expect(isPermission("ledger:delete")).toBe(false);
  });

  it("system_admin cannot touch ledger data", () => {
    const admin = SYSTEM_ROLES.find((role) => role.key === "system_admin");
    expect(admin).toBeDefined();
    const permissions = admin?.permissions ?? [];
    expect(permissions.includes("ledger:read")).toBe(false);
    expect(permissions.includes("ledger:reverse")).toBe(false);
  });

  it("auditor is read-only (no manage or reverse permissions)", () => {
    const auditor = SYSTEM_ROLES.find((role) => role.key === "auditor");
    const permissions = auditor?.permissions ?? [];
    expect(permissions.every((p) => !p.endsWith(":manage"))).toBe(true);
    expect(permissions.includes("ledger:reverse")).toBe(false);
  });
});

describe("authorization guards", () => {
  const officer = principal({
    userId: "u1",
    tenantId: "t1",
    displayName: "Officer",
    roles: ["officer"],
    permissions: ["asset:read", "dispute:read"],
  });

  it("grants a held permission and denies an unheld one", () => {
    expect(can(officer, "asset:read")).toBe(true);
    expect(can(officer, "ledger:reverse")).toBe(false);
  });

  it("assertPermission throws ForbiddenError when any permission is missing", () => {
    expect(() => assertPermission(officer, "asset:read", "dispute:read")).not.toThrow();
    expect(() => assertPermission(officer, "asset:read", "ledger:reverse")).toThrow(ForbiddenError);
  });

  it("rejects unknown permission keys when building a principal", () => {
    expect(() =>
      principal({
        userId: "u",
        tenantId: "t",
        displayName: "x",
        roles: [],
        permissions: ["not:a:permission"],
      }),
    ).toThrow(ForbiddenError);
  });
});
