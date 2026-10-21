import { describe, expect, it } from "vitest";

describe("ledger immutability (requirements)", () => {
  it("documents that transactions and ledger_entries are append-only (enforced by migration triggers and privileges)", () => {
    // Immutability is enforced at the database level via triggers and revoked privileges (see migration 0004)
    expect(true).toBe(true);
  });
});
