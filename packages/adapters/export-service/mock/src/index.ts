import type { ExportRequest, ExportResult, ExportService } from "@tpirs/ports";

function csvEscape(value: unknown): string {
  let text: string;
  if (value === undefined || value === null) {
    text = "";
  } else if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else {
    text = JSON.stringify(value);
  }
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(request: ExportRequest): Uint8Array {
  const header = request.columns.map((c) => csvEscape(c.header)).join(",");
  const lines = request.rows.map((row) =>
    request.columns.map((c) => csvEscape(row[c.key])).join(","),
  );
  return new TextEncoder().encode([header, ...lines].join("\n") + "\n");
}

export interface MockExportService extends ExportService {
  /** Formats the mock knows how to produce. */
  readonly supportedFormats: readonly string[];
}

export function createMockExportService(): MockExportService {
  return {
    supportedFormats: ["csv"],
    export(request): Promise<ExportResult> {
      if (request.format !== "csv") {
        return Promise.resolve({
          format: request.format,
          contentType: "application/octet-stream",
          filename: `${request.filenameBase}.${request.format}`,
          bytes: new Uint8Array(),
        });
      }
      return Promise.resolve({
        format: "csv",
        contentType: "text/csv",
        filename: `${request.filenameBase}.csv`,
        bytes: toCsv(request),
      });
    },
  };
}
