import type { Money, SettlementDatePattern } from "@tpirs/domain";

/**
 * Importing a settlement statement (D21, ADR 0035).
 *
 * A bank statement is not a payment event: it has no signature, no provider
 * event id and no intent. It therefore cannot honestly implement
 * `PaymentProvider`. This port converts the document into normalised rows;
 * matching them to payments and posting the money is reconciliation's job.
 *
 * The port owns no column names. Every bank exports differently, so the caller
 * supplies a mapping read from tenant config, and an adapter that cannot honour
 * the mapping rejects the whole import rather than guessing.
 */

/** Statement formats an adapter can read. */
export type SettlementImportFormat = "csv";

export interface SettlementColumnMapping {
  /** Column holding the gateway's reference for the payment. */
  readonly reference: string;
  /** Column holding the gross amount that was charged. */
  readonly amount: string;
  /** Column holding the gateway's fee, when the statement breaks it out. */
  readonly fee?: string;
  /** Column holding the ISO currency; omitted means the request default. */
  readonly currency?: string;
  /** Column holding the settlement date (and optionally the time). */
  readonly settledAt: string;
  /** Pattern the settled-at column uses. Values are read as UTC. */
  readonly settledAtFormat: SettlementDatePattern;
  /** The amount column holds minor units (`50000`) rather than `500.00`. */
  readonly amountInMinorUnits: boolean;
  /** Which character separates the fraction in an amount column. */
  readonly decimalSeparator: "." | ",";
  /** Column retained verbatim as evidence, e.g. the narration. */
  readonly description?: string;
}

export interface SettlementImportRequest {
  /** Provider key the rows will be matched against. */
  readonly provider: string;
  readonly filename: string;
  /** The statement body as text. The caller owns decoding. */
  readonly content: string;
  readonly mapping: SettlementColumnMapping;
  /** Currency used when the mapping declares no currency column. */
  readonly defaultCurrency: string;
}

export interface ImportedSettlementRow {
  /** 1-based line number in the source document, for the rejection report. */
  readonly rowNumber: number;
  /** SHA-256 hex over the normalised row; stable across re-uploads. */
  readonly rowHash: string;
  readonly providerReference: string;
  /** Gross amount charged to the driver. */
  readonly amount: Money;
  /** Gateway fee, `0` when the statement does not break it out. */
  readonly fee: Money;
  readonly settledAt: Date;
  readonly description: string | null;
  readonly raw: Readonly<Record<string, string>>;
}

export type SettlementRejectionReason =
  | "missing_column"
  | "missing_reference"
  | "invalid_amount"
  | "invalid_fee"
  | "invalid_settled_at"
  | "invalid_currency"
  | "duplicate_row";

export interface SettlementRowRejection {
  readonly rowNumber: number;
  readonly reason: SettlementRejectionReason;
  readonly detail: string;
}

export interface SettlementImportResult {
  readonly format: SettlementImportFormat;
  /** SHA-256 hex over the raw statement bytes; the import's identity. */
  readonly fileHash: string;
  /** Rows accepted into the import, after duplicate suppression. */
  readonly rowCount: number;
  readonly rows: readonly ImportedSettlementRow[];
  readonly rejected: readonly SettlementRowRejection[];
}

export interface SettlementImportCapabilities {
  readonly formats: readonly SettlementImportFormat[];
  /** Mapping keys the adapter requires before it can read a statement. */
  readonly requiredColumns: readonly (keyof SettlementColumnMapping)[];
}

export interface SettlementImport {
  capabilities(): SettlementImportCapabilities;
  /**
   * Reads one statement. Throws `PortError("invalid_request")` when the mapping
   * or the document header makes the file unreadable as a whole; individual bad
   * rows are reported in `rejected` so one typo does not hide the day.
   */
  parse(request: SettlementImportRequest): Promise<SettlementImportResult>;
}
