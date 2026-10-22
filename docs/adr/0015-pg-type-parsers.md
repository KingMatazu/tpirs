# 0015: `pg` type parsers for `int8` and `date`

## Context

The Kysely schema in `packages/db/src/connection.ts` declares money columns as
`bigint` and business dates as `string`:

```ts
export interface ObligationPeriodTable {
  amountMinor: bigint;
  businessDate: string;
  ...
}
```

`node-postgres` ships with two defaults that disagree with those
declarations. Verified against Postgres 16:

| Column type   | `pg` default                           | Declared type |
| ------------- | -------------------------------------- | ------------- |
| `int8`        | `"20000"` (string)                     | `bigint`      |
| `date`        | `2026-06-14T23:00:00.000Z` (JS `Date`) | `string`      |
| `int4`        | `20000` (number)                       | `number`      |
| `sum(bigint)` | `"20000"` (numeric string)             | —             |

Both mismatches are silent. A `bigint` that arrives as a string still prints
like a number and still compares equal to a number in a test, but
`"20000" - "0"` produces a JS **number**, and mixing that with a `bigint`
throws `TypeError: Cannot mix BigInt and other types`. A `date` that arrives
as a `Date` never equals the `"YYYY-MM-DD"` string it names, so a comparison
such as `period.businessDate === businessDate` is simply always false.

The second mismatch was silent in a way that broke the product rather than
the build: under `pay_per_use` no allocation ever happened, because the
candidate filter compared a `Date` with a string and never matched. Under
`scheduled` the same bug surfaced as a `BigInt` mix error, because the
subtraction of two date-string-derived amounts produced a number.

The alternative — converting in every repository — would leave the declared
types lying and would spread a conversion to every new call site.

## Decision

- `packages/db/src/connection.ts` overrides the two parsers at module load:

  ```ts
  pg.types.setTypeParser(pg.types.builtins.INT8, (value) => BigInt(value));
  pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
  ```

- The runtime now matches the declared types: a `bigint` column is a
  `bigint`, and a `date` column is the `"YYYY-MM-DD"` string the domain
  works with.
- `numeric` is deliberately **not** overridden. `sum()` over `bigint` returns
  `numeric`, which can hold a fraction; the repositories that aggregate
  convert explicitly (`accountBalance` calls `BigInt(...)` on the result), so
  a decimal would fail loudly instead of being silently truncated.
- `int4` is left alone: `pg` already returns a number, which matches the
  declaration.

## Consequences

- Domain code can rely on `amountMinor: bigint` and `businessDate: string`
  without defensive conversion, and the TypeScript types are truthful.
- The parsers are process-global, so every Kysely instance in the process
  (including the test suites) sees the same mapping. That is the intent: the
  mapping is a property of the schema, not of one connection.
- `count(*)` and other `int8` aggregates also arrive as `bigint` now. No
  application code counts rows today; a future count must use `Number(...)`
  or `BigInt(...)` deliberately rather than assume a number.
- The change is invisible to the API surface: money crosses the wire as a
  JSON number, and the API layer converts explicitly.

## Alternatives considered

- **Convert in the repositories.** Rejected: the declared types would still be
  wrong, and every new call site would have to remember to convert. The
  mismatch would resurface in the next repository written.
- **Use `numeric` for money instead of `bigint`.** Rejected: money in minor
  units is an integer by definition, and `numeric` brings decimal semantics
  and a string representation that buys nothing here.
- **Keep `bigint` columns but declare them as `string`.** Rejected: the
  arithmetic in the allocation engine is integer arithmetic; strings would
  force a conversion at every step and reintroduce the mixed-type bug.
- **Parse `date` into a `Date` and adapt the domain to it.** Rejected: a
  business date is a calendar label, not an instant. Turning it into an
  instant reintroduces timezone ambiguity, which is exactly what the tenant
  timezone rules exist to avoid.
- **Override the `numeric` parser as well.** Rejected: it would silently
  truncate a fractional sum. Explicit conversion at the aggregation site
  fails loudly, which is what a financial system needs.
