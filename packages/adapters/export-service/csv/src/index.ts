import type { ExportRequest, ExportResult, ExportService } from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/**
 * CSV export (ADR 0034).
 *
 * Hand-written rather than borrowed: the format is one header line and escaped
 * rows, and the escaping is the only part worth testing. RFC 4180 quoting:
 * a field is quoted when it contains a comma, a double quote or a line break,
 * and an inner quote is doubled.
 */

function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function escapeCell(value: unknown): string {
  const text = cellText(value).replaceAll("\r\n", "\n");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function render(request: ExportRequest): Uint8Array {
  const header = request.columns.map((column) => escapeCell(column.header)).join(",");
  const lines = request.rows.map((row) =>
    request.columns.map((column) => escapeCell(row[column.key])).join(","),
  );
  // CRLF is what RFC 4180 asks for and what spreadsheet tools expect.
  const body = [header, ...lines].join("\r\n");
  return new TextEncoder().encode(`${body}\r\n`);
}

export function createCsvExportService(): ExportService {
  return {
    export(request: ExportRequest): Promise<ExportResult> {
      if (request.format !== "csv") {
        return Promise.reject(
          new PortError(
            "ExportService",
            "invalid_request",
            `CSV adapter cannot export ${request.format}`,
          ),
        );
      }
      return Promise.resolve({
        format: "csv",
        contentType: "text/csv",
        filename: `${request.filenameBase}.csv`,
        bytes: render(request),
      });
    },
  };
}
