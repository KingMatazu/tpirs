import ExcelJS from "exceljs";
import type { ExportRequest, ExportResult, ExportService } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/**
 * XLSX export (ADR 0034).
 *
 * `exceljs` writes a real workbook with typed cells rather than a CSV renamed
 * to `.xlsx`, which is the failure mode a finance team notices immediately:
 * a column of numbers that cannot be summed.
 */

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel refuses these characters in a sheet name and caps it at 31 characters. */
function sheetName(filenameBase: string): string {
  const cleaned = filenameBase
    .replaceAll(/[[\]:*?/\\]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const name = cleaned === "" ? "Report" : cleaned;
  return name.slice(0, 31);
}

function cellValue(value: unknown): ExcelJS.CellValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

export async function renderXlsx(request: ExportRequest): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  const worksheet = workbook.addWorksheet(sheetName(request.filenameBase), {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  worksheet.columns = request.columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: Math.max(14, Math.min(40, column.header.length + 4)),
  }));
  worksheet.getRow(1).font = { bold: true };

  for (const row of request.rows) {
    const values: Record<string, ExcelJS.CellValue> = {};
    for (const column of request.columns) {
      values[column.key] = cellValue(row[column.key]);
    }
    worksheet.addRow(values);
  }

  // Money and identifiers stay text or numbers as supplied; nothing is
  // reformatted here, so the tenant's locale cannot change the bytes.
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  return bytes;
}

export function createXlsxExportService(): ExportService {
  return {
    export(request: ExportRequest): Promise<ExportResult> {
      if (request.format !== "xlsx") {
        return Promise.reject(
          new PortError(
            "ExportService",
            "invalid_request",
            `XLSX adapter cannot export ${request.format}`,
          ),
        );
      }
      return renderXlsx(request).then((bytes) => ({
        format: "xlsx",
        contentType: XLSX_CONTENT_TYPE,
        filename: `${request.filenameBase}.xlsx`,
        bytes,
      }));
    },
  };
}
