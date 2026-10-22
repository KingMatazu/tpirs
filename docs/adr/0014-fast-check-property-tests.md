# 0014: `fast-check` for property tests, pinned exactly

## Context

Build brief section 8 asks for property tests (total debits equal total
credits), and build brief section 9 for Phase 3 asks for "property tests
(debits equal credits); allocation tests across timezone boundaries and fee
changes". Unit tests check the cases the author thought of; properties check
the cases the author did not.

Phase 3 introduced three property suites in `packages/domain`:
`ledger.property.test.ts`, `allocation.property.test.ts`, and
`fee-engine.property.test.ts`.

Property-based testing needs a generator library. Adding one is a supply-chain
decision, and the brief requires: "Do not add a dependency without recording
the alternative considered in an ADR."

## Decision

- `fast-check` **4.10.2** is a devDependency of `packages/domain` only,
  pinned to an exact version (no caret, no range). It never reaches a
  production bundle: it is a test-time dependency of one package.
- The only transitive dependency is `pure-rand@^8.0.0`, which `fast-check`
  uses for its pseudo-random source. `pnpm audit` reports no findings for
  either package.
- The property harness lives in `packages/domain/src/test-support/property.ts`
  and is excluded from the package build (`tsconfig.json` excludes
  `src/test-support/**`), so the harness is not emitted into `dist`.
- `checkProperty(name, property, options)` runs a property with:
  - `numRuns` from `propertyRunCount()`, which reads `FAST_CHECK_RUNS` and
    falls back to `DEFAULT_PROPERTY_RUNS = 100` for CI,
  - the seed logged on failure, plus the counterexample path, the
    counterexample itself, and the underlying cause, so a CI failure can be
    reproduced locally without guesswork,
  - `examples` seeded as **regression cases**: a failing case is pasted back
    into the suite as a fixed example so it never regresses silently.
- The nightly CI job runs the suite with a much higher `FAST_CHECK_RUNS`
  (2000) to explore more of the space, while the per-commit run stays at 100
  to keep the feedback loop fast.

## Consequences

- The properties are checked against generated inputs rather than hand-picked
  ones, which is how the `pay_per_use` all-or-nothing rule and the wallet
  conservation rule were pinned down.
- A failing property is reproducible: the seed is printed, and
  `fc.check` accepts a `seed` option, so the same case can be replayed.
- Because `fast-check` is a devDependency of one package, a supply-chain
  compromise affects test runs only, never a deployed artifact. The exact
  pin plus a lockfile audit keeps the blast radius small.
- The `examples:` entries are tuple values in fast-check v4: a single
  arbitrary needs `examples: [[value]]` and two arbitraries need
  `examples: [[v1, v2]]`. The suites follow that shape.

## Alternatives considered

- **Hand-rolled generators.** Rejected: shrinking the input space is exactly
  the bug-prone part of property testing, and a hand-rolled shrinker produces
  poor counterexamples. The cost of the dependency is a devDependency in one
  package; the cost of writing our own generator library is much higher and
  would be maintained forever.
- **`jsverify`.** Rejected: smaller ecosystem and less active maintenance;
  `fast-check` also integrates with Vitest's assertion library, which the
  suites already use.
- **`fuzzers` / `jsverify` alternatives with TypeScript-first types.**
  Rejected for the same reason: `fast-check` ships its own TypeScript types,
  so no `@types/*` package is needed.
- **Vitest's built-in `expect` fuzzing (`vitest-fuzz`).** Rejected: it is
  less expressive than a generator-based property framework, and it does not
  shrink counterexamples the way `fast-check` does.
- **A runtime dependency.** Rejected: property testing is a development
  activity and must not ship.
- **Floating versions (`^4.10.0`).** Rejected: a minor bump can change
  generator behaviour and therefore the set of generated cases; the brief
  requires a recorded alternative for every dependency, and an exact pin is
  the simplest way to keep CI reproducible.

## Supply-chain check

`pnpm audit` is part of the CI verification step. The five findings it reports
are pre-existing and confined to the test runner (`vitest`, `tinypool`,
`@vitest/mocker`); `fast-check` and `pure-rand` are clean. The lockfile is
committed, so a compromised release cannot enter the build without a visible
lockfile change.
