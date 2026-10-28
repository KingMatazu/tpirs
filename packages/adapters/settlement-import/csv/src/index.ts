import { createHash } from "node:crypto";
import {
  InvalidSettlementRowError,
  isSettlementDatePattern,
  money,
  parseSettlementAmountMinor,
  parseSettlementDate,
  settlementRowKey,
} from "@tpirs/domain";
import type {
  ImportedSettlementRow,
  SettlementColumnMapping,
  SettlementImport,
  SettlementImportCapabilities,
  SettlementImportRequest,
  SettlementImportResult,
  SettlementRowRejection,
} from "@tpirs/ports";
import { PortError } from "@tpirs/ports";

/**
 * CSV statement import (ADR 0035).
 *
 * The column mapping comes from tenant config, so no bank format lives here.
 * One row that cannot be normalised is reported and skipped; a file that cannot
 * be read at all (missing mapped column, unterminated quote) is rejected whole,
 * because a partial import of a statement is worse than a failed one.
 */

const REQUIRED_COLUMNS: readonly (keyof SettlementColumnMapping)[] = [
  "reference",
  "amount",
  "settledAt",
  "settledAtFormat",
  "amountInMinorUnits",
  "decimalSeparator",
];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawQuote = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    sawQuote = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") {
      quoted = true;
      sawQuote = true;
    } else if (character === ",") {
      endField();
    } else if (character === "\n") {
      endRow();
    } else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new PortError(
      "SettlementImport",
      "invalid_request",
      "statement ends inside a quoted field",
    );
  }
  if (field !== "" || row.length > 0 || sawQuote) endRow();
  return rows;
}

function fail(message: string): never {
  throw new PortError("SettlementImport", "invalid_request", message);
}

function assertMapping(mapping: SettlementColumnMapping): void {
  for (const key of ["reference", "amount", "settledAt"] as const) {
    if (mapping[key].trim() === "") fail(`mapping.${key} is required`);
  }
  const dateFormat: string = mapping.settledAtFormat;
  if (!isSettlementDatePattern(dateFormat)) {
    fail(`mapping.settledAtFormat "${dateFormat}" is not a supported date pattern`);
  }
  // The mapping is tenant config, so its values are runtime data even though
  // the port types them as literals.
  const separator: string = mapping.decimalSeparator;
  if (separator !== "." && separator !== ",") {
    fail(`mapping.decimalSeparator must be "." or ","`);
  }
}

function parseRows(
  request: SettlementImportRequest,
  table: readonly (readonly string[])[],
): SettlementImportResult {
  const header = (table[0] ?? []).map((name) => name.trim());
  const required = [
    request.mapping.reference,
    request.mapping.amount,
    request.mapping.settledAt,
    ...(request.mapping.fee === undefined ? [] : [request.mapping.fee]),
    ...(request.mapping.currency === undefined ? [] : [request.mapping.currency]),
    ...(request.mapping.description === undefined ? [] : [request.mapping.description]),
  ];
  for (const column of required) {
    if (!header.includes(column)) {
      fail(`statement has no "${column}" column (found: ${header.join(", ")})`);
    }
  }

  const rows: ImportedSettlementRow[] = [];
  const rejected: SettlementRowRejection[] = [];
  const seen = new Set<string>();

  for (let index = 1; index < table.length; index += 1) {
    const cells = table[index] ?? [];
    if (cells.every((cell) => cell.trim() === "")) continue;
    const rowNumber = index + 1;
    const record: Record<string, string> = {};
    header.forEach((name, position) => {
      record[name] = cells[position] ?? "";
    });

    const reject = (reason: SettlementRowRejection["reason"], detail: string): void => {
      rejected.push({ rowNumber, reason, detail });
    };

    const reference = (record[request.mapping.reference] ?? "").trim();
    if (reference === "") {
      reject("missing_reference", "reference column is empty");
      continue;
    }

    const currency = (
      request.mapping.currency === undefined
        ? request.defaultCurrency
        : (record[request.mapping.currency] ?? "")
    )
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      reject("invalid_currency", `currency "${currency}" is not an ISO 4217 code`);
      continue;
    }

    const amountRule = {
      amountInMinorUnits: request.mapping.amountInMinorUnits,
      decimalSeparator: request.mapping.decimalSeparator,
    };

    let amountMinor: bigint;
    try {
      amountMinor = parseSettlementAmountMinor(record[request.mapping.amount] ?? "", amountRule);
    } catch (error) {
      if (error instanceof InvalidSettlementRowError) {
        reject("invalid_amount", error.message);
        continue;
      }
      throw error;
    }

    let feeMinor = 0n;
    if (request.mapping.fee !== undefined) {
      const feeText = (record[request.mapping.fee] ?? "").trim();
      if (feeText !== "") {
        try {
          feeMinor = parseSettlementAmountMinor(feeText, amountRule);
        } catch (error) {
          if (error instanceof InvalidSettlementRowError) {
            reject("invalid_fee", error.message);
            continue;
          }
          throw error;
        }
      }
    }

    let settledAt: Date;
    try {
      settledAt = parseSettlementDate(
        record[request.mapping.settledAt] ?? "",
        request.mapping.settledAtFormat,
      );
    } catch (error) {
      if (error instanceof InvalidSettlementRowError) {
        reject("invalid_settled_at", error.message);
        continue;
      }
      throw error;
    }

    const rowHash = sha256(
      settlementRowKey({
        providerReference: reference,
        amountMinor,
        feeMinor,
        currency,
        settledAt,
      }),
    );
    if (seen.has(rowHash)) {
      reject("duplicate_row", "the same row appears earlier in this statement");
      continue;
    }
    seen.add(rowHash);

    const description =
      request.mapping.description === undefined
        ? null
        : (record[request.mapping.description] ?? "").trim();

    try {
      rows.push({
        rowNumber,
        rowHash,
        providerReference: reference,
        amount: money(currency, Number(amountMinor)),
        fee: money(currency, Number(feeMinor)),
        settledAt,
        description,
        raw: record,
      });
    } catch (error) {
      reject("invalid_amount", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    format: "csv",
    fileHash: sha256(request.content),
    rowCount: rows.length,
    rows,
    rejected,
  };
}

export function createCsvSettlementImport(): SettlementImport {
  const capabilities = (): SettlementImportCapabilities => ({
    formats: ["csv"],
    requiredColumns: REQUIRED_COLUMNS,
  });

  return {
    capabilities,
    parse(request: SettlementImportRequest): Promise<SettlementImportResult> {
      return Promise.resolve().then(() => {
        assertMapping(request.mapping);
        const table = parseCsvRows(request.content);
        if (table.length === 0) fail("statement is empty");
        return parseRows(request, table);
      });
    },
  };
}
