# Runbook: local development

## First-time setup

```sh
corepack enable
pnpm install
pnpm setup
```

`pnpm setup` copies `.env.example` to `.env`, starts Postgres/Redis/MinIO via
`infra/docker-compose.yml`, applies migrations, and seeds.

## Everyday

```sh
pnpm dev:infra     # start containers only
pnpm dev           # run dev servers (turbo)
pnpm db:migrate    # apply new migrations
pnpm db:check      # prove migrations are reversible
```

## Resetting

```sh
docker compose -f infra/docker-compose.yml down -v
pnpm setup
```

## Integration tests (real Postgres)

DB-backed suites (auth, audit, RLS, identity, asset-registry e2e) skip unless
`TEST_DATABASE_URL` is set. Two options:

```sh
sh scripts/ci/integration.sh        # scratch Postgres + migrations + full suite
```

or, against the dev database on port 5433:

```sh
pnpm db:migrate
export TEST_DATABASE_URL="postgres://tpirs:tpirs@localhost:5433/tpirs"
pnpm test
```

On Windows (PowerShell) the Git-bash script works via
`& "C:\Program Files\Git\bin\bash.exe" scripts/ci/integration.sh`, or export the
variable with `$env:TEST_DATABASE_URL=...` and run `pnpm test` directly.

## Seeded users

After `pnpm setup` (or `pnpm db:seed`):

| Tenant      | Username        | Role          |
| ----------- | --------------- | ------------- |
| alpha-state | alpha.admin     | system_admin  |
| alpha-state | alpha.officer   | officer       |
| alpha-state | alpha.collector | collector     |
| beta-state  | beta.admin      | system_admin  |
| beta-state  | beta.finance    | finance_admin |
| beta-state  | beta.officer    | officer       |

## Ports

- Postgres: `5433` (host) → 5432
- Redis: `6380` (host) → 6379
- MinIO: `9000` (API), `9001` (console)
- API: `3000`

## Troubleshooting

- Docker not running: start Docker Desktop, then re-run `pnpm dev:infra`.
- Migration check failing: a migration is not reversible; fix its `down`.
- Lint failing on a new file: run `pnpm format` then `pnpm lint`.
