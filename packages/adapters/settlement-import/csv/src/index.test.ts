import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSettlementImportConformanceSuite,
  settlementImportConformanceFixture,
} from "@tpirs/contracts";
import { settlementRowKey } from "@tpirs/domain";
import type { SettlementColumnMapping } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";
import { createCsvSettlementImport, parseCsvRows } from "./index.js";

const fixture = settlementImportConformanceFixture;

createSettlementImportConformanceSuite({ describe, it, expect }, () => ({
  port: createCsvSettlementImport(),
}));

const baseMapping = {
  reference: "reference",
  amount: "amount",
  settledAt: "date",
  settledAtFormat: "YYYY-MM-DD",
  amountInMinorUnits: false,
  decimalSeparator: ".",
} satisfies SettlementColumnMapping;

function request(content: string, mapping: SettlementColumnMapping = baseMapping) {
  return { ...fixture.request, content, mapping };
}

describe("createCsvSettlementImport", () => {
  it("reads the shared fixture into gross amount, fee and instant", async () => {
    const result = await createCsvSettlementImport().parse(fixture.request);

    expect(result.rowCount).toBe(2);
    expect(result.rejected).toEqual([]);
    const [first, second] = result.rows;
    expect(first?.providerReference).toBe("PSK-CONF-1");
    expect(first?.amount).toEqual({ currency: "NGN", amount: 50_000 });
    expect(first?.fee).toEqual({ currency: "NGN", amount: 1_000 });
    expect(first?.settledAt.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(first?.description).toBe("Levy 500");
    expect(second?.amount.amount).toBe(123_450);
  });

  it("hashes the normalised row, not the raw text", async () => {
    const result = await createCsvSettlementImport().parse(fixture.request);
    const first = result.rows[0];
    if (first === undefined) throw new Error("fixture row missing");
    const expected = createHash("sha256")
      .update(
        settlementRowKey({
          providerReference: first.providerReference,
          amountMinor: BigInt(first.amount.amount),
          feeMinor: BigInt(first.fee.amount),
          currency: first.amount.currency,
          settledAt: first.settledAt,
        }),
        "utf8",
      )
      .digest("hex");
    expect(first.rowHash).toBe(expected);
  });

  it("gives the same file hash to the same bytes under any filename", async () => {
    const importer = createCsvSettlementImport();
    const a = await importer.parse(fixture.request);
    const b = await importer.parse({ ...fixture.request, filename: "renamed.csv" });
    expect(b.fileHash).toBe(a.fileHash);
  });

  it("reads comma decimals and day-first dates", async () => {
    const importer = createCsvSettlementImport();
    const result = await importer.parse(
      request(["reference,amount,date", 'PSK-9,"1.234,50",04/03/2026'].join("\n"), {
        ...baseMapping,
        settledAtFormat: "DD/MM/YYYY",
        decimalSeparator: ",",
      }),
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.amount.amount).toBe(123_450);
    expect(result.rows[0]?.settledAt.toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });

  it("reads a minor-unit amount column without scaling it", async () => {
    const result = await createCsvSettlementImport().parse(
      request(["reference,amount,date", "PSK-9,50000,2026-03-04"].join("\n"), {
        ...baseMapping,
        amountInMinorUnits: true,
      }),
    );
    expect(result.rows[0]?.amount.amount).toBe(50_000);
  });

  it("keeps a narration that contains commas and quotes", async () => {
    const result = await createCsvSettlementImport().parse(
      request(
        ["reference,amount,date,narration", 'PSK-1,500.00,2026-03-04,"Levy, ""bike"" 500"'].join(
          "\n",
        ),
        { ...baseMapping, description: "narration" },
      ),
    );
    expect(result.rows[0]?.description).toBe('Levy, "bike" 500');
    expect(result.rows[0]?.raw["narration"]).toBe('Levy, "bike" 500');
  });

  it("reports individual bad rows and keeps the good ones", async () => {
    const result = await createCsvSettlementImport().parse(
      request(
        [
          "reference,amount,fee,date",
          "PSK-1,500.00,10.00,2026-03-04",
          ",500.00,10.00,2026-03-04",
          "PSK-3,not-a-number,0,2026-03-04",
          "PSK-4,500.00,bad,2026-03-04",
          "PSK-5,500.00,0,2026-02-30",
          "PSK-6,500.00,0,04/03/2026",
        ].join("\n"),
        { ...baseMapping, fee: "fee" },
      ),
    );

    expect(result.rowCount).toBe(1);
    expect(result.rejected.map((row) => [row.rowNumber, row.reason])).toEqual([
      [3, "missing_reference"],
      [4, "invalid_amount"],
      [5, "invalid_fee"],
      [6, "invalid_settled_at"],
      [7, "invalid_settled_at"],
    ]);
  });

  it("refuses a currency the tenant does not use", async () => {
    const result = await createCsvSettlementImport().parse(
      request(["reference,amount,date,currency", "PSK-1,500.00,2026-03-04,US"].join("\n"), {
        ...baseMapping,
        currency: "currency",
      }),
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("invalid_currency");
    expect(result.rejected[0]?.detail).toContain("US");
  });

  it("suppresses the same row appearing twice in one file", async () => {
    const result = await createCsvSettlementImport().parse(
      request(
        [
          "reference,amount,date",
          "PSK-1,500.00,2026-03-04",
          "PSK-1,500.00,2026-03-04",
          "PSK-1,500.01,2026-03-04",
        ].join("\n"),
      ),
    );
    expect(result.rowCount).toBe(2);
    expect(result.rejected.map((row) => row.reason)).toEqual(["duplicate_row"]);
  });

  it("rejects a file whose mapped column is absent", async () => {
    const importer = createCsvSettlementImport();
    const error: unknown = await importer
      .parse(request(["amount,date", "500.00,2026-03-04"].join("\n")))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("invalid_request");
    expect((error as PortError).message).toContain("reference");
  });

  it("rejects an empty statement and an unterminated quote", async () => {
    const importer = createCsvSettlementImport();
    const empty: unknown = await importer.parse(request("")).catch((cause) => cause);
    expect(empty).toBeInstanceOf(PortError);
    const broken: unknown = await importer
      .parse(request('reference,amount,date\n"PSK-1,500.00,2026-03-04'))
      .catch((cause) => cause);
    expect(broken).toBeInstanceOf(PortError);
  });

  it("rejects a mapping with no reference column", async () => {
    const importer = createCsvSettlementImport();
    const error: unknown = await importer
      .parse(
        request(["reference,amount,date", "PSK-1,500.00,2026-03-04"].join("\n"), {
          ...baseMapping,
          reference: " ",
        }),
      )
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(PortError);
  });
});

describe("parseCsvRows", () => {
  it("handles CRLF, trailing newlines and quoted newlines", () => {
    expect(parseCsvRows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsvRows('a,b\n"line\nbreak",2\n')).toEqual([
      ["a", "b"],
      ["line\nbreak", "2"],
    ]);
  });
});
