import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { createExportServiceConformanceSuite } from "@tpirs/contracts";
import { PortError } from "@tpirs/ports";
import { createXlsxExportService } from "./index.js";

createExportServiceConformanceSuite(
  { describe, it, expect },
  () => ({ port: createXlsxExportService() }),
  { formats: ["xlsx"] },
);

async function open(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return workbook;
}

describe("createXlsxExportService", () => {
  it("writes a header row and typed cells that a spreadsheet can sum", async () => {
    const result = await createXlsxExportService().export({
      format: "xlsx",
      columns: [
        { key: "zone", header: "Zone" },
        { key: "revenueMinor", header: "Revenue (minor)" },
      ],
      rows: [
        { zone: "Central", revenueMinor: 120_000n },
        { zone: "Riverside", revenueMinor: 80_000 },
      ],
      filenameBase: "collections-by-zone",
    });

    expect(result.filename).toBe("collections-by-zone.xlsx");
    const workbook = await open(result.bytes);
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) throw new Error("worksheet missing");

    expect(sheet.getRow(1).values).toEqual([undefined, "Zone", "Revenue (minor)"]);
    const first = sheet.getCell("B2");
    expect(first.value).toBe(120_000);
    expect(typeof first.value).toBe("number");
  });

  it("keeps an amount too large for a spreadsheet number as text", async () => {
    const result = await createXlsxExportService().export({
      format: "xlsx",
      columns: [{ key: "amountMinor", header: "Amount (minor)" }],
      rows: [{ amountMinor: 9_007_199_254_740_993n }],
      filenameBase: "huge",
    });
    const workbook = await open(result.bytes);
    expect(workbook.worksheets[0]?.getCell("A2").value).toBe("9007199254740993");
  });

  it("sanitises a sheet name the format would reject", async () => {
    const result = await createXlsxExportService().export({
      format: "xlsx",
      columns: [{ key: "id", header: "ID" }],
      rows: [{ id: "1" }],
      filenameBase: "collections/[zone]:*?",
    });
    const workbook = await open(result.bytes);
    expect(workbook.worksheets[0]?.name).toBe("collections zone");
  });

  it("refuses a format it does not implement", async () => {
    const error: unknown = await createXlsxExportService()
      .export({ format: "csv", columns: [], rows: [], filenameBase: "nope" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PortError);
  });
});
