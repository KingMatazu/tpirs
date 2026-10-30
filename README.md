# TPIRS

White-label, multi-tenant revenue collection platform. The first deployment is a
per-use levy system for bikes and tuk-tuks; the same codebase is resold to other
states by writing configuration, not code.

See `AGENTS.md` for the full build brief (design principles, ports and adapters,
phases, and the quality bar). This README covers how to run the repo. Phases 0–9
are implemented. Phase 9 completes the admin dashboard (registry, payments,
suspense, disputes, reversals, reconciliation, reports, collectors, config and
audit screens) with permission-aware navigation, tenant branding and a
catalogue-driven language switch. Phase 8 adds reconciliation, reporting and
anomaly detection:
statement import with the fee leg, append-only nightly runs and sign-off, the
exception queue, six finance reports with CSV/PDF/XLSX exports, configurable
anomaly rules, the worker schedule, the API routes and the admin screens (see
`docs/runbooks/reconciliation.md` and `docs/runbooks/reports.md`).

**Run it locally:** [`docs/runbooks/local-development.md`](docs/runbooks/local-development.md)
has the complete guide — Docker services, dev servers, seeded logins, everyday
commands, tests against the Docker database, and troubleshooting.

## Layout

```
apps/api            HTTP delivery layer (Fastify)
apps/admin          admin dashboard (React + Vite, api-client only)
apps/field          officer field app, offline-capable PWA (React + Vite)
apps/worker         background worker (outbox sweepers, SMS/channel delivery)
packages/domain     pure business logic (Money, IDs, ledger, allocation, USSD)
packages/ports      port interfaces (hexagonal boundaries)
packages/contracts  conformance suites every adapter must pass
packages/adapters   one folder per adapter (mock + real)
packages/application use-case services wiring domain + ports
packages/channel-providers tenant config and secrets to channel adapters
packages/config     tenant config schema, loader, and validation
packages/crypto     hashing and HMAC helpers (passwords, QR tokens)
packages/i18n       message catalogs and templating
packages/db         Kysely connection, migrations, seed
packages/api-client generated OpenAPI client used by every frontend
packages/ui-tokens  design tokens and theming
tenants             per-tenant config only
docs                ADRs, runbooks, decisions-needed
infra               compose, Dockerfiles, deploy targets
scripts             setup and CI entrypoints
```

## Prerequisites

- Node 24 (see `.node-version`)
- pnpm 11 (`corepack enable`)
- Docker (for local Postgres, Redis, SeaweedFS)

## Quick start

```sh
pnpm install
pnpm setup        # copies .env, starts containers, migrates, seeds
pnpm dev          # run all dev servers (scripts/dev.mjs); Ctrl+C stops them all
```

Then open <http://localhost:5173> and sign in with tenant `alpha-state`,
username `alpha.admin`, password `alpha-admin-password` (all seeded accounts are
listed in the local-development runbook).

## Common tasks

```sh
pnpm build        # build all packages
pnpm lint         # eslint across the workspace
pnpm typecheck    # tsc across the workspace
pnpm test         # vitest across the workspace
pnpm db:migrate   # apply migrations
pnpm db:check     # prove migrations apply and roll back
pnpm dev:infra    # start local Postgres/Redis/SeaweedFS only
```

## Architecture rules (enforced)

- Domain logic is pure TypeScript with no framework, ORM, or vendor imports.
- Every external dependency sits behind a port with at least two adapters.
- Every adapter passes the shared conformance suite in `packages/contracts`.
- No tenant-specific literals in code; behavior comes from tenant config.
- Ledger and audit tables are append-only.

## CI and delivery

CI is a thin caller of `scripts/ci/*`; the logic lives in shell scripts and turbo
tasks so the CI vendor is swappable. On merge to `main`, the image is built and
pushed to GHCR, the staging compose profile is brought up against it, the smoke
test runs, then the deploy step runs through `infra/deploy/<target>.sh`
(default `noop`). See `docs/adr/0003-ci-strategy.md` and
`docs/adr/0004-delivery-and-deploy.md`.
