# ADR 0034: Export adapters for CSV, PDF and XLSX

## Status

Accepted

## Context

`packages/ports/src/export-service.ts` has declared `csv`, `pdf` and `xlsx`
since Phase 0, and the shared conformance suite in `packages/contracts` covers
them. The only adapter is `@tpirs/export-service-mock`, and it produces real CSV
but returns empty bytes for the other two formats. Nothing in the platform has
ever needed a file: Phase 8's reports are the first thing a finance team will
actually ask for as a spreadsheet or a printable page.

Three constraints shape the choice:

- **The port is the seam.** A report route must not know how a PDF is written.
  Adding a format must be an adapter plus a registry entry, not a route change.
- **`pnpm 11` blocks postinstall scripts.** Only `esbuild` is allowed to build in
  this repo (`allowBuilds` in `pnpm-workspace.yaml`). A library that compiles
  native code or downloads a binary at install time cannot be used without
  weakening that policy.
- **Exports are a request/response, not a pipeline.** A finance user picks a
  range and downloads a file.

## Decision

- **Three real adapters, one per format**, named
  `@tpirs/export-service-csv`, `-pdf` and `-xlsx`, in
  `packages/adapters/export-service/`. The mock stays for tests. The application
  resolves format → adapter from a registry, so a tenant can be given a different
  implementation without touching the report code.
- **CSV is hand-written.** The format is a header line plus escaped rows; the
  mock already contains a correct RFC 4180 escaper (quotes, commas, newlines and
  doubled inner quotes). A CSV library would add a dependency to do what thirty
  lines already do, and the escaping is worth testing directly rather than
  inheriting untested.
- **PDF uses `pdf-lib`.** Pure JavaScript, no native module, no postinstall, no
  headless browser. It writes the font, the tenant's branding header and footer
  from config, and a table of text runs. It is not a layout engine, which is
  acceptable: these are tabular reports, not brochures.
- **XLSX uses `exceljs`.** MIT-licensed, pure JavaScript, no native build. It
  writes typed cells (numbers as numbers, dates as dates) rather than a CSV
  renamed to `.xlsx`, which is the failure mode finance teams notice first.
- **The conformance suite covers every format, not just CSV.** The suite becomes
  format-parameterised: a CSV result must parse back into the same header and
  rows, an XLSX result must re-open with `exceljs` and expose the same values,
  and a PDF result must have a valid header, a parseable cross-reference table
  and contain the expected text. An adapter that cannot satisfy that for a
  declared format must not declare it.
- **Exports are synchronous with a hard cap.** One request produces one file of
  at most 100,000 rows or one calendar month, whichever is reached first.
  Beyond it the service raises `range_too_large` and the caller narrows the
  range. A queued export behind `JobQueue` is deferred until load tests show the
  cap is a real constraint.
- **Money and dates are exported in their own terms.** Money is an integer
  minor-unit column with the currency named once per file (not per row), and
  dates use the tenant's locale and timezone. A file that cannot be summed in a
  spreadsheet without string parsing is a file finance will re-type.

## Consequences

- Reports gain three download formats and no report-specific code: the report
  declares columns, the adapter renders them.
- The two new dependencies are pure JavaScript. If a future version of either
  tries to run a postinstall script, the install fails loudly, which is the
  intended behaviour.
- PDF output is deliberately plain: a heading, the range, the tenant's
  configured footer, and a table. Anything richer (charts, wrapping of long
  cells) is a rendering decision that would pull in a layout engine for a
  reporting feature.
- The suite now proves bytes, not intent: an adapter that returns empty bytes for
  a declared format fails conformance instead of silently producing a blank
  download.
- Synchronous generation costs a request holding a connection for the duration
  of the file. At pilot volumes (a month of a state's transactions) that is
  under a second; if it stops being, the port already returns bytes, so the
  change is where the call happens, not what it returns.

## Alternatives considered

- **`pdfkit`** — a larger, more capable PDF library, but its font handling and
  streaming API are more machinery than a table needs, and `pdf-lib`'s pure-JS
  promise is the deciding factor under the no-postinstall rule.
- **A headless browser (Playwright/Puppeteer) rendering HTML to PDF** — the
  highest-fidelity option, rejected because it adds a Chromium download, a
  process model and a deployment concern for a tabular report.
- **SheetJS community edition** — popular and capable, but its licence and
  maintenance posture are less clear than `exceljs`, and the API surface used
  here is small.
- **CSV only in Phase 8, PDF and XLSX later** — rejected: the acceptance check
  is a finance user signing off a month, and both a printable summary and a
  spreadsheet are part of what a finance user means by "a report".
- **Streaming exports with a `ReadableStream` return type** — rejected for now:
  it changes the port, forces every adapter to implement backpressure, and the
  row cap makes the benefit theoretical.
