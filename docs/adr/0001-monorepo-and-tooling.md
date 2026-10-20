# 0001: Monorepo, package manager, and tooling

## Context

The platform is one codebase resold to many states. It needs shared domain
packages, multiple deployable apps, and a quality bar (typed end to end, strict
compiler settings, lint and format enforced in CI) applied uniformly.

## Decision

- Single pnpm-workspace monorepo orchestrated by Turborepo.
- pnpm (pinned via `packageManager`, Corepack) for installs.
- TypeScript in strict mode with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and ESM/NodeNext module resolution.
- ESLint 9 flat config with `strictTypeChecked` + `stylisticTypeChecked`, plus
  Prettier. Hooks: husky + lint-staged + commitlint (conventional commits).
- Vitest for all tests.

## Consequences

- One install, one lint/type/build/test graph; caching via turbo.
- Relative imports need explicit `.js` extensions (NodeNext).
- Workspace packages are scoped `@tpirs/*`.

## Alternatives considered

- Nx: rejected as heavier than needed for this size and less transparent.
- npm/yarn workspaces: rejected on install performance and workspace protocol.
- Non-strict TypeScript: rejected by the quality bar in `AGENTS.md`.
