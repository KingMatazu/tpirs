import { describe, expect, it } from "vitest";
import { settlementImportConformanceFixture } from "@tpirs/contracts";
import { createSettlementImportConformanceSuite } from "@tpirs/contracts";
import type { ImportedSettlementRow } from "@tpirs/ports";
import { createMockSettlementImport } from "./index.js";

const fixture = settlementImportConformanceFixture;

function rows(): ImportedSettlementRow[] {
  return fixture.references.map((reference, index) => ({
    rowNumber: index + 2,
    rowHash: fakeHash(reference),
    providerReference: reference,
    amount: { currency: "NGN", amount: index === 0 ? 50_000 : 123_450 },
    fee: { currency: "NGN", amount: index === 0 ? 1_000 : 0 },
    settledAt: new Date("2026-03-04T00:00:00.000Z"),
    description: null,
    raw: {},
  }));
}

/** A stable 64-hex placeholder; the mock does not hash rows itself. */
function fakeHash(seed: string): string {
  let hash = "";
  for (let index = 0; index < 64; index += 1) {
    hash += (seed.charCodeAt(index % seed.length) % 16).toString(16);
  }
  return hash;
}

createSettlementImportConformanceSuite({ describe, it, expect }, () => ({
  port: createMockSettlementImport({ rows: rows() }),
}));

describe("createMockSettlementImport", () => {
  it("returns the configured rows and a content-derived hash", async () => {
    const importer = createMockSettlementImport({ rows: rows() });
    const result = await importer.parse(fixture.request);
    expect(result.rows.map((row) => row.providerReference)).toEqual(["PSK-CONF-1", "PSK-CONF-2"]);
    expect(result.rejected).toEqual([]);
  });

  it("gives different content a different file hash", async () => {
    const importer = createMockSettlementImport({ rows: rows() });
    const one = await importer.parse(fixture.request);
    const two = await importer.parse({
      ...fixture.request,
      content: `${fixture.request.content}\n`,
    });
    expect(two.fileHash).not.toBe(one.fileHash);
  });
});
