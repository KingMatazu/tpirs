# ADR 0035: Settlement import as its own port

## Status

Accepted

## Context

Reconciliation compares what the platform believes with what the bank says.
Until now the only way money entered the books was through a provider webhook:
`PaymentProvider.verifyWebhook` and `normalizeWebhook` turn a signed payload into
a payment, and `supportsSettlementFetch`/`fetchSettlements` on the same port can
ask a gateway what it settled.

A bank statement is a different animal. It is a CSV (or a PDF printed from one),
it has no signature, no provider event id, no intent lifecycle, and no
deduplication key. It arrives from the tenant's bank, not from the gateway, and
D21 already records the conclusion: statement import is a separate port.

The matching problem is also specific. Two drivers can pay the same levy on the
same day, so amount and date cannot identify a payment. The gateway's reference
in the description column can.

## Decision

- **A new port, `SettlementImport`,** in `packages/ports/src/settlement-import.ts`:
  declared capabilities (accepted formats, required columns), and one entry point
  that takes a file plus the tenant's column mapping and returns normalised rows
  plus the file hash. It never posts, never matches and never touches
  `payments`; it converts a document into rows.
- **No bank format lives in core.** The adapter receives a mapping from the
  tenant config (reference column, amount column, fee column, date column, date
  format, whether amounts are already minor units, decimal separator). A tenant
  whose bank changes its export format changes config, not code.
- **Idempotency is a file hash plus a row hash.** The file hash is SHA-256 over
  the raw bytes, unique per `(tenant, provider)`; `settlement_rows` is unique on
  `(tenant, import_id, row_hash)` where the row hash covers the _normalised_
  fields. A byte-identical re-upload is a no-op that reports the original
  import; a re-export with different spacing, header order or an overlapping date
  range still cannot create a second row for the same transaction.
- **Matching is by provider reference, inside the tenant, and only when exactly
  one payment carries it.** Ambiguity is a result, not a coin flip: zero matches
  is `unmatched`, two matches is an exception.
- **`PaymentProvider.Settlement` gains an optional fee.** An API settlement feed
  can then report the gateway's cut, and a statement adapter reports what the
  file says. When no fee is reported the fee is zero and any shortfall is either
  within `reconciliation.feeToleranceMinor` or an exception (ADR 0036). No
  adapter is permitted to compute a fee it was not told.
- **The port feeds reconciliation only.** Imported rows are evidence, not
  payments: they cannot create a `payments` row, cannot mark a day paid, and
  cannot be the thing that makes a vehicle verified as `paid`.

## Consequences

- A statement from a bank nobody has integrated can be reconciled by editing
  tenant config, which is the situation every new state starts in.
- The mock and CSV adapters both pass the shared conformance suite, so the next
  source (a bank API, an aggregator file) is accepted only when it produces
  identical normalised rows from identical evidence.
- The row hash is computed over normalised values, so a bank's cosmetic changes
  do not create duplicate rows, while a genuinely repeated transaction on the
  same day (same reference, same amount) is deduplicated by construction —
  which is what the gateway's own uniqueness promise means.
- Extending `Settlement` with a fee is a contract change: every payment adapter
  and its fixture suite must still pass with the field absent.
- The import is bounded by file size and row count at the route, and by the
  column mapping at parse time; a malformed amount or an unparseable date
  rejects the row with a reason rather than coercing a number.

## Alternatives considered

- **Reusing `PaymentProvider` for statements** — rejected on evidence: the
  interface promises signature verification, event dedupe and intent
  attribution, none of which a statement can supply. An adapter that returns
  "verified" for an unsigned file is a lie the type system would enforce.
- **Filename plus period as identity** — rejected: banks re-issue statements
  under new names, and two different files can cover the same day.
- **Fuzzy matching on amount and date** — rejected: it silently mis-attributes
  a payment when two levies coincide, which is precisely the error a
  reconciliation feature exists to prevent.
- **A provider-specific parser per bank in core** — rejected: the number of
  banks is open-ended and each state differs; mapping belongs in tenant config.
- **Deriving the fee from a percentage** — rejected: gateway pricing changes
  without notice and is not one number per merchant. An assumed fee would post
  wrong money confidently.
