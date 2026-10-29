# Runbook: running TPIRS locally

Everything needed to run the platform on one machine and click through the
dashboard: Docker for the data services, the API and UIs on the host.

- **Docker** runs Postgres, Redis and the S3-compatible object store.
- **Host** runs the API, the admin dashboard, the field PWA and the worker.
- The dashboard proxies `/v1` to the API, so the browser sees one origin.

## 1. Prerequisites

| Tool           | Version | Check         |
| -------------- | ------- | ------------- |
| Docker Desktop | current | `docker info` |
| Node           | 24      | `node -v`     |
| pnpm           | 11.1.3  | `pnpm -v`     |

Start Docker Desktop before anything else.

If pnpm is missing:

```sh
corepack enable
```

On Windows, if `corepack enable` is blocked, install pnpm directly:

```powershell
npm install -g pnpm@11.1.3
```

## 2. One-time setup

```sh
git clone https://github.com/KingMatazu/tpirs.git
cd tpirs

pnpm install
pnpm setup
```

`pnpm setup` (`scripts/setup.mjs`) does four things:

1. copies `.env.example` to `.env` (only if `.env` is missing),
2. starts Postgres, Redis and SeaweedFS with
   `docker compose -f infra/docker-compose.yml up -d --wait`,
3. applies every migration (`pnpm db:migrate`),
4. seeds the two demo tenants (`pnpm db:seed`).

If a step fails, fix that step and re-run `pnpm setup`; it is safe to repeat.

## 3. Start the whole system

```sh
pnpm dev
```

This runs every `dev` task through turbo in one terminal:

| Service         | URL                     | Notes                                                          |
| --------------- | ----------------------- | -------------------------------------------------------------- |
| Admin dashboard | <http://localhost:5173> | the interface to test                                          |
| API             | <http://localhost:3000> | `/v1/health`, `/v1/ready`, `/v1/openapi.json`                  |
| Field PWA       | <http://localhost:5174> | officer app, offline-capable                                   |
| Worker          | —                       | outbox sweepers, SMS/channel delivery, reconciliation schedule |
| Postgres        | `localhost:5433`        | user `tpirs`, password `tpirs`, database `tpirs`               |
| Redis           | `localhost:6380`        |                                                                |
| Object storage  | `localhost:9000`        | SeaweedFS S3 API (`tpirs-uploads`, `tpirs-exports`)            |

If you only need the dashboard and API:

```sh
pnpm --filter @tpirs/api dev
pnpm --filter @tpirs/admin dev
```

Add `pnpm --filter @tpirs/worker dev` in a third terminal if you want the
nightly reconciliation schedule and outbox delivery to run.

## 4. Log in

Open <http://localhost:5173>. The login form takes a **tenant slug**, a
**username** and a **password**.

| Tenant slug   | Username          | Password                   | Role          |
| ------------- | ----------------- | -------------------------- | ------------- |
| `alpha-state` | `alpha.admin`     | `alpha-admin-password`     | system admin  |
| `alpha-state` | `alpha.officer`   | `alpha-officer-password`   | officer       |
| `alpha-state` | `alpha.collector` | `alpha-collector-password` | collector     |
| `beta-state`  | `beta.admin`      | `beta-admin-password`      | system admin  |
| `beta-state`  | `beta.finance`    | `beta-finance-password`    | finance admin |
| `beta-state`  | `beta.officer`    | `beta-officer-password`    | officer       |

Use `alpha.admin` to see everything, `beta.finance` for the finance and
reconciliation screens, and `alpha.collector` to check the restricted view.
TOTP is off locally (`REQUIRE_STAFF_TOTP=false`).

The two tenants differ in currency, timezone, fee rules, languages and
reconciliation tolerances — switching tenants re-themes and re-labels the
dashboard with no code change.

## 5. What to try

- **Collectors** — the seeded alpha collector has a wallet and demo cash
  activity. Take cash, match a deposit, freeze/unfreeze.
- **Reconciliation** — run list with the persisted checklist, the exception
  queue with resolve/waive (a note is required), and sign-off (also needs a
  note; blocked while a blocking exception is open). Runs appear once the worker
  has reconciled a business day according to the tenant's cron
  (`reconciliation.schedule`, in the tenant timezone).
- **Reports** — the six finance reports, business-day range, and CSV/PDF/XLSX
  downloads. Reports and the audit log show seeded data immediately.
- **Configuration** — the validated tenant config, including the Phase 8
  reconciliation keys (tolerances, anomaly rules, statement mapping).
- **Audit** — every state-changing request with actor, request id and before/after.
- **USSD simulator** and **Channels** — driver-channel behaviour without a phone.

The field PWA at <http://localhost:5174> uses the same API and tenants.

## 6. Everyday commands

```sh
pnpm dev:infra     # start only Postgres/Redis/SeaweedFS
pnpm dev           # start API + admin + field + worker
pnpm db:migrate    # apply new migrations
pnpm db:seed       # re-run the seed (safe to repeat)
pnpm db:check      # prove every migration applies and rolls back
```

Stop the containers without deleting data:

```sh
docker compose -f infra/docker-compose.yml down
```

Full reset (deletes the database volumes, then re-creates and seeds):

```sh
docker compose -f infra/docker-compose.yml down -v
pnpm setup
```

Open a psql shell:

```sh
docker compose -f infra/docker-compose.yml exec postgres psql -U tpirs -d tpirs
```

Follow container logs:

```sh
docker compose -f infra/docker-compose.yml logs -f postgres
```

## 7. Run the tests against the Docker database

DB-backed suites skip unless `TEST_DATABASE_URL` is exported.

PowerShell:

```powershell
$env:TEST_DATABASE_URL="postgres://tpirs:tpirs@localhost:5433/tpirs"
pnpm test
```

Git Bash / WSL:

```bash
export TEST_DATABASE_URL="postgres://tpirs:tpirs@localhost:5433/tpirs"
pnpm test
```

Full CI-style integration run (starts its own scratch Postgres on `:55433`,
migrates, then runs the whole suite; needs Docker and a POSIX shell):

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/ci/integration.sh
```

Prove migrations are reversible:

```sh
pnpm ci:migration-check
```

## 8. Troubleshooting

| Symptom                                          | Fix                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` fails or `--wait` hangs         | Docker Desktop is not running, or ports `5433`/`6380`/`9000` are taken.                                                                               |
| `pnpm dev` cannot reach the database             | `.env` is missing or containers are down: run `pnpm setup` or `pnpm dev:infra`.                                                                       |
| Login fails                                      | Use the exact slug (`alpha-state`), and confirm `pnpm setup`/`pnpm db:seed` ran.                                                                      |
| Dashboard requests fail with 404/502             | The API is not on `:3000`; start it with `pnpm dev` or the API filter command above.                                                                  |
| No reconciliation runs yet                       | The worker schedules them from the tenant cron; Reports and Audit show data already.                                                                  |
| Port already in use                              | Stop the conflicting process, or change `API_PORT` in `.env` and the Vite `server.port` in `apps/admin/vite.config.ts` / `apps/field/vite.config.ts`. |
| A migration check fails                          | A migration's `down()` is not reversible; fix it before merging.                                                                                      |
| `pnpm install` warns about blocked build scripts | Only `esbuild` is allowed by pnpm 11; the warning is expected.                                                                                        |

## 9. What runs where (and why)

The dev compose file (`infra/docker-compose.yml`) contains only infrastructure:
Postgres, Redis, SeaweedFS and a one-shot bucket initialiser. The API, worker
and both UIs run on the host so edits hot-reload.

There is no dashboard container in the dev profile. The staging compose
(`infra/docker-compose.staging.yml`) builds the API image from
`infra/docker/app.Dockerfile` for CI smoke tests; the dashboard is a static
build served separately in production.

All tenant behaviour — currency, timezone, fees, channels, cash rules,
reconciliation schedule and tolerances, anomaly rules, statement columns — comes
from tenant config. If you want a third tenant, copy
`tenants/_template/tenant.config.yaml`, validate it, and create the tenant row;
no code changes are involved.
