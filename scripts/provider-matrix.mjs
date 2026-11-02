#!/usr/bin/env node
/**
 * Generates the provider capabilities matrix in `docs/onboarding/`.
 *
 * The matrix is *derived*, not hand-written: every row is read from the adapter's
 * own `capabilities()` call, so a guide can never claim a provider supports
 * something its code does not declare. Run it after `pnpm build` (the adapters
 * are imported from `dist/`), then commit the regenerated document:
 *
 *   node scripts/provider-matrix.mjs --write
 *
 * `--check` is the same generation with a diff instead of a write, for CI or a
 * pre-commit habit:
 *
 *   node scripts/provider-matrix.mjs --check
 *
 * Options passed to a factory here are placeholders. `capabilities()` is pure
 * and never reads them, and no adapter in this list touches the network when it
 * is constructed.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUTPUT = new URL("../docs/onboarding/provider-matrix.md", import.meta.url);

const yesNo = (value) => (value === true ? "yes" : value === false ? "no" : String(value));
const list = (values) => (values.length === 0 ? "—" : values.join(", "));

function adapter(label, path, build, options = {}) {
  return { label, path, build, ...options };
}

const PORTS = [
  {
    key: "PaymentProvider",
    source: "packages/ports/src/payment-provider.ts",
    note: "`attributionKinds` decides how a payment is tied to an asset (ADR 0018). `supportsVirtualAccounts` and `supportsPaymentReferences` are convenience flags the conformance suite keeps consistent with it.",
    columns: ["Attribution kinds", "Virtual accounts", "Payment references", "Settlement fetch"],
    values: (capabilities) => [
      list(capabilities.attributionKinds),
      yesNo(capabilities.supportsVirtualAccounts),
      yesNo(capabilities.supportsPaymentReferences),
      yesNo(capabilities.supportsSettlementFetch),
    ],
    adapters: [
      adapter(
        "Paystack",
        "../packages/adapters/payment-provider/paystack/dist/index.js",
        (module) => module.createPaystackPaymentProvider(),
      ),
      adapter("Remita", "../packages/adapters/payment-provider/remita/dist/index.js", (module) =>
        module.createRemitaPaymentProvider(),
      ),
      adapter(
        "Mock",
        "../packages/adapters/payment-provider/mock/dist/index.js",
        (module) => module.createMockPaymentProvider(),
        { mock: true },
      ),
    ],
  },
  {
    key: "SmsProvider",
    source: "packages/ports/src/sms-provider.ts",
    note: "Delivery reports are push callbacks at both real aggregators; the port models polling, so an adapter without them returns an empty list rather than inventing data.",
    columns: ["Delivery receipts", "Inbound SMS", "Max segments"],
    values: (capabilities) => [
      yesNo(capabilities.supportsDeliveryReceipts),
      yesNo(capabilities.supportsInbound),
      String(capabilities.maxSegments),
    ],
    adapters: [
      adapter(
        "Africa's Talking",
        "../packages/adapters/sms-provider/africastalking/dist/index.js",
        (module) =>
          module.createAfricaSTalkingSmsProvider({
            username: "placeholder",
            apiKey: "placeholder",
            transport: { send: async () => ({ status: 200, body: "{}" }) },
          }),
      ),
      adapter("Termii", "../packages/adapters/sms-provider/termii/dist/index.js", (module) =>
        module.createTermiiSmsProvider({
          apiKey: "placeholder",
          senderId: "PLACEHOLDER",
          transport: { send: async () => ({ status: 200, body: "{}" }) },
        }),
      ),
      adapter(
        "Mock",
        "../packages/adapters/sms-provider/mock/dist/index.js",
        (module) => module.createMockSmsProvider(),
        { mock: true },
      ),
    ],
  },
  {
    key: "UssdProvider",
    source: "packages/ports/src/ussd-provider.ts",
    note: "`maxResponseLength` is what the session engine budgets a menu prompt against; exceeding it silently truncates on the handset.",
    columns: ["Max response length", "Service code in callback"],
    values: (capabilities) => [
      String(capabilities.maxResponseLength),
      yesNo(capabilities.supportsServiceCode),
    ],
    adapters: [
      adapter(
        "Africa's Talking",
        "../packages/adapters/ussd-provider/africastalking/dist/index.js",
        (module) => module.createAfricaSTalkingUssdProvider(),
      ),
      adapter(
        "Mock",
        "../packages/adapters/ussd-provider/mock/dist/index.js",
        (module) => module.createMockUssdProvider(),
        { mock: true },
      ),
    ],
  },
  {
    key: "SettlementImport",
    source: "packages/ports/src/settlement-import.ts",
    note: "A statement importer is a separate port from `PaymentProvider` (D21): a gateway may expose settlements through an export file rather than an API, and a bank statement has no gateway at all.",
    columns: ["Formats", "Required mapping keys"],
    values: (capabilities) => [list(capabilities.formats), list(capabilities.requiredColumns)],
    adapters: [
      adapter("CSV", "../packages/adapters/settlement-import/csv/dist/index.js", (module) =>
        module.createCsvSettlementImport(),
      ),
      adapter(
        "Mock",
        "../packages/adapters/settlement-import/mock/dist/index.js",
        (module) => module.createMockSettlementImport(),
        { mock: true },
      ),
    ],
  },
];

async function inspect(port) {
  const rows = [];
  for (const entry of port.adapters) {
    let capabilities;
    try {
      const module = await import(new URL(entry.path, import.meta.url));
      capabilities = entry.build(module).capabilities();
    } catch (error) {
      throw new Error(
        `Could not read ${entry.label} (${port.key}) from ${entry.path}. Run \`pnpm build\` first.\n${String(error)}`,
        { cause: error },
      );
    }
    rows.push({ ...entry, values: port.values(capabilities) });
  }
  return rows;
}

function table(port, rows) {
  const header = ["Adapter", ...port.columns];
  const body = rows.map((row) => [
    row.mock === true ? `${row.label} (not for production)` : row.label,
    ...row.values,
  ]);
  // Padded exactly the way Prettier pads a Markdown table, so `--write` and
  // `pnpm format` agree and `--check` can be a byte comparison.
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((row) => row[column].length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

async function generate() {
  const sections = [];
  for (const port of PORTS) {
    const rows = await inspect(port);
    sections.push(
      [
        `## ${port.key}`,
        "",
        `Declared by \`capabilities()\` in \`${port.source}\`.`,
        "",
        port.note,
        "",
        table(port, rows),
      ].join("\n"),
    );
  }

  return [
    "# Provider capabilities matrix",
    "",
    "<!-- Generated by `node scripts/provider-matrix.mjs --write`. Do not edit by hand. -->",
    "",
    "Every row below is read from the adapter's own `capabilities()` call after a",
    "build, so this file cannot drift from the code. It is the factual half of",
    "[`provider-decision-guide.md`](./provider-decision-guide.md); that document",
    "explains how to choose, this one states what each adapter declares.",
    "",
    "An adapter appears here only if it passes the shared conformance suite in",
    "`@tpirs/contracts`. The mock is included so a deployment can be exercised",
    "without a provider account; it is not a candidate for production.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

const mode = process.argv.includes("--check")
  ? "check"
  : process.argv.includes("--write")
    ? "write"
    : "print";

const generated = await generate();

if (mode === "write") {
  await writeFile(OUTPUT, generated, "utf8");
  console.log(`wrote ${fileURLToPath(OUTPUT)}`);
} else if (mode === "check") {
  let current = "";
  try {
    current = await readFile(OUTPUT, "utf8");
  } catch {
    console.error(`${fileURLToPath(OUTPUT)} is missing; run --write`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      `${fileURLToPath(OUTPUT)} is stale; run \`node scripts/provider-matrix.mjs --write\``,
    );
    process.exit(1);
  }
  console.log("provider matrix is up to date");
} else {
  process.stdout.write(generated);
}
