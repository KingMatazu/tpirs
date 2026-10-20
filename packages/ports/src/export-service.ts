export type ExportFormat = "csv" | "pdf" | "xlsx";

export interface ExportColumn {
  readonly key: string;
  readonly header: string;
}

export interface ExportRequest {
  readonly format: ExportFormat;
  readonly columns: readonly ExportColumn[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly filenameBase: string;
}

export interface ExportResult {
  readonly format: ExportFormat;
  readonly contentType: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface ExportService {
  export(request: ExportRequest): Promise<ExportResult>;
}
