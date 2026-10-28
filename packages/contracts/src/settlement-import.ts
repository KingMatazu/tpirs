import type { SettlementImport, SettlementImportRequest } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import type { AdapterFactory, ConformanceHarness } from "./harness.js";
import { withAdapter } from "./harness.js";

/**
 * One statement every conforming adapter must read. The content is the smallest
 * useful CSV: a header, one settled row and one unsettled row, so an adapter
 * cannot pass by echoing a single hardcoded row.
 */
export const settlementImportConformanceFixture = {
  request: {
    provider: "conformance-gateway",
    filename: "conformance-statement.csv",
    content: [
      "reference,amount,fee,date,narration",
      "PSK-CONF-1,500.00,10.00,2026-03-04,Levy 500",
      'PSK-CONF-2,"1,234.50",0.00,2026-03-04,Levy 1234.50',
    ].join("\n"),
    mapping: {
      reference: "reference",
      amount: "amount",
      fee: "fee",
      settledAt: "date",
      settledAtFormat: "YYYY-MM-DD",
      amountInMinorUnits: false,
      decimalSeparator: ".",
      description: "narration",
    },
    defaultCurrency: "NGN",
  } satisfies SettlementImportRequest,
  /** Provider references the fixture contains, in order. */
  references: ["PSK-CONF-1", "PSK-CONF-2"] as const,
  expectedRows: 2,
} as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface SettlementImportConformanceOptions {
  /** Rows the adapter should accept from the shared fixture. */
  readonly expectedRows?: number;
}

export function createSettlementImportConformanceSuite(
  harness: ConformanceHarness,
  factory: AdapterFactory<SettlementImport>,
  options: SettlementImportConformanceOptions = {},
): void {
  const { describe, it, expect } = harness;
  const fixture = settlementImportConformanceFixture;
  const expectedRows = options.expectedRows ?? fixture.expectedRows;

  describe("SettlementImport conformance", () => {
    it("declares CSV and the mapping keys it needs", () =>
      withAdapter(factory, (importer) => {
        const capabilities = importer.capabilities();
        expect(capabilities.formats).toContain("csv");
        expect(capabilities.requiredColumns).toContain("reference");
        expect(capabilities.requiredColumns).toContain("amount");
        expect(capabilities.requiredColumns).toContain("settledAt");
      }));

    it("returns a stable SHA-256 file hash and normalised rows", () =>
      withAdapter(factory, async (importer) => {
        const first = await importer.parse(fixture.request);
        const second = await importer.parse(fixture.request);

        expect(first.format).toBe("csv");
        expect(first.fileHash).toMatch(HASH_PATTERN);
        expect(second.fileHash).toBe(first.fileHash);
        expect(first.rowCount).toBe(expectedRows);
        expect(first.rows).toHaveLength(expectedRows);

        for (const row of first.rows) {
          expect(row.rowHash).toMatch(HASH_PATTERN);
          expect(row.providerReference.length).toBeGreaterThan(0);
          expect(row.amount.currency).toBe(fixture.request.defaultCurrency);
          expect(row.fee.currency).toBe(fixture.request.defaultCurrency);
          expect(Number.isInteger(row.amount.amount)).toBe(true);
          expect(row.settledAt).toBeInstanceOf(Date);
          expect(Number.isNaN(row.settledAt.getTime())).toBe(false);
        }
      }));

    it("derives the row hash from the normalised row, not from call order", () =>
      withAdapter(factory, async (importer) => {
        const first = await importer.parse(fixture.request);
        const second = await importer.parse(fixture.request);
        expect(second.rows.map((row) => row.rowHash)).toEqual(first.rows.map((row) => row.rowHash));
      }));

    it("refuses a mapping that omits a required column", () =>
      withAdapter(factory, async (importer) => {
        const broken = {
          ...fixture.request,
          mapping: { ...fixture.request.mapping, reference: "" },
        };
        const error: unknown = await importer.parse(broken).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("invalid_request");
      }));
  });
}
