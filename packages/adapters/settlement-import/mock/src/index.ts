import { createHash } from "node:crypto";
import { isSettlementDatePattern } from "@tpirs/domain";
import type {
  ImportedSettlementRow,
  SettlementColumnMapping,
  SettlementImport,
  SettlementImportCapabilities,
  SettlementImportRequest,
  SettlementImportResult,
} from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/**
 * In-memory settlement importer for tests and demos.
 *
 * It owns no parsing: the rows are supplied when the adapter is built, and the
 * file hash is the SHA-256 of whatever content the caller passes. That keeps it
 * a stand-in for the *contract* (identity, determinism, row shape) rather than a
 * second CSV implementation that could drift from the real adapter.
 */

export interface MockSettlementImportOptions {
  readonly rows?: readonly ImportedSettlementRow[];
}

const REQUIRED_COLUMNS: readonly (keyof SettlementColumnMapping)[] = [
  "reference",
  "amount",
  "settledAt",
  "settledAtFormat",
  "amountInMinorUnits",
  "decimalSeparator",
];

export function createMockSettlementImport(
  options: MockSettlementImportOptions = {},
): SettlementImport {
  const rows = options.rows ?? [];

  const capabilities = (): SettlementImportCapabilities => ({
    formats: ["csv"],
    requiredColumns: REQUIRED_COLUMNS,
  });

  return {
    capabilities,
    parse(request: SettlementImportRequest): Promise<SettlementImportResult> {
      // Rejections are promises, not synchronous throws: a caller that only
      // handles a rejected promise must still see an invalid mapping.
      return Promise.resolve().then((): SettlementImportResult => {
        for (const key of ["reference", "amount", "settledAt"] as const) {
          if (request.mapping[key].trim() === "") {
            throw new PortError(
              "SettlementImport",
              "invalid_request",
              `mapping.${key} is required`,
            );
          }
        }
        const dateFormat: string = request.mapping.settledAtFormat;
        if (!isSettlementDatePattern(dateFormat)) {
          throw new PortError(
            "SettlementImport",
            "invalid_request",
            `mapping.settledAtFormat "${dateFormat}" is not supported`,
          );
        }
        return {
          format: "csv",
          fileHash: createHash("sha256").update(request.content, "utf8").digest("hex"),
          rowCount: rows.length,
          rows: [...rows],
          rejected: [],
        };
      });
    },
  };
}
