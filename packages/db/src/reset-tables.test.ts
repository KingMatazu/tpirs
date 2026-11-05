import { describe, expect, it } from "vitest";
import { isDataTable } from "./reset-tables.js";

describe("demo reset table selection", () => {
  it("keeps the migration record, which is the schema's own state", () => {
    expect(isDataTable("kysely_migration")).toBe(false);
    expect(isDataTable("kysely_migration_lock")).toBe(false);
  });

  it("wipes application tables", () => {
    for (const table of ["tenants", "users", "assets", "ledger_entries", "audit_log"]) {
      expect(isDataTable(table)).toBe(true);
    }
  });
});
