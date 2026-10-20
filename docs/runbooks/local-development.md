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

## Ports

- Postgres: `5433` (host) → 5432
- Redis: `6380` (host) → 6379
- MinIO: `9000` (API), `9001` (console)
- API: `3000`

## Troubleshooting

- Docker not running: start Docker Desktop, then re-run `pnpm dev:infra`.
- Migration check failing: a migration is not reversible; fix its `down`.
- Lint failing on a new file: run `pnpm format` then `pnpm lint`.
