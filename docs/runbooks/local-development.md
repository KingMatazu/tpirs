# Runbook: running TPIRS locally

Everything needed to run the platform on one machine and click through every
app: Docker for the data services, the API and the UIs on the host.

- **Docker** runs Postgres, Redis and the S3-compatible object store.
- **Host** runs the API, the worker, and three browser UIs: the admin dashboard,
  the officer PWA and the collector PWA.
- Each UI proxies `/v1` to the API, so every app talks to one origin and the
  httpOnly refresh cookie works the same way in all of them.

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
pnpm setup --seed
```

`pnpm setup` (`scripts/setup.mjs`) prepares a fresh install:

1. copies `.env.example` to `.env` (only if `.env` is missing),
2. starts Postgres, Redis and SeaweedFS with `docker compose -f
infra/docker-compose.yml up -d`,
3. applies every migration (`pnpm db:migrate`).

It does **not** create a tenant. Run `pnpm dev` and open
<http://localhost:5173>: the first-run wizard onboards the first tenant in the
browser. To work with the two demo tenants instead, run `pnpm setup --seed`,
which also calls `pnpm db:seed`.

If a step fails, fix that step and re-run `pnpm setup`; it is safe to repeat.

## 3. Start the whole system

```sh
pnpm dev
```

This starts all five dev servers in one terminal through `scripts/dev.mjs`
(prefixing each line with the app name). One Ctrl+C stops all of them, including
the compiler processes `tsx watch` spawns:

| Service         | URL                     | Notes                                                              |
| --------------- | ----------------------- | ------------------------------------------------------------------ |
| API             | <http://localhost:3000> | `/v1/health`, `/v1/ready`, `/v1/openapi.json`, `/metrics` (opt-in) |
| Admin dashboard | <http://localhost:5173> | back office: registry, payments, finance, audit, config            |
| Officer PWA     | <http://localhost:5174> | scan a sticker, offline-capable, disputes and a scan log           |
| Collector PWA   | <http://localhost:5175> | register a vehicle, take cash, deposit the float                   |
| Worker          | —                       | outbox sweepers, SMS/channel delivery, reconciliation schedule     |
| Postgres        | `localhost:5433`        | user `tpirs`, password `tpirs`, database `tpirs`                   |
| Redis           | `localhost:6380`        |                                                                    |
| Object storage  | `localhost:9000`        | SeaweedFS S3 API (`tpirs-uploads`, `tpirs-exports`)                |

### Which app for which role

The same person does not use the same app for everything, and a role that signs
into the wrong one sees an honest, mostly empty shell:

| Role                                            | App           | URL                     |
| ----------------------------------------------- | ------------- | ----------------------- |
| system admin, finance, auditor, zone supervisor | Dashboard     | <http://localhost:5173> |
| officer                                         | Officer PWA   | <http://localhost:5174> |
| collector                                       | Collector PWA | <http://localhost:5175> |

Every app accepts the same seeded credentials (§4) — the role decides what is
visible, not which login form you use.

If you only need one app and the API, filter it:

```sh
pnpm --filter @tpirs/api dev
pnpm --filter @tpirs/admin dev      # :5173
pnpm --filter @tpirs/field dev      # :5174
pnpm --filter @tpirs/collector dev  # :5175
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
TOTP is off locally (`REQUIRE_STAFF_TOTP=false`), and the sign-in forms have no
code field in v1 — sign-in is tenant, username, password. Do not turn that flag on
yet: the API would demand a code no form can send, and every staff user would be
locked out.

`alpha.officer` belongs in the officer PWA (<http://localhost:5174>) and
`alpha.collector` in the collector PWA (<http://localhost:5175>); both also sign
into the dashboard, where they see only the pages their permissions allow.

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
- **Officer PWA** (<http://localhost:5174>) — sign in as `alpha.officer`, sync the
  paid list, then scan a sticker or type `B000001`. To see a green result, pay
  that vehicle first through the dashboard's USSD simulator, sync again, and
  scan. Turn the network off (DevTools → Network → Offline) and scan again: the
  card says "not in the offline list", never "unpaid", and the scan waits in the
  outbox until the connection returns. The dispute form and the scan log are on
  the same screens.
- **Collector PWA** (<http://localhost:5175>) — sign in as `alpha.collector` to
  register a vehicle at the roadside, take cash against a short code, and see the
  float against its ceiling before depositing.

All three UIs use the same API and the same two tenants.

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

Full reset (deletes the database volumes, then re-creates — and, with `--seed`,
seeds):

```sh
docker compose -f infra/docker-compose.yml down -v
pnpm setup --seed
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

| Symptom                                                         | Fix                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` fails or `--wait` hangs                        | Docker Desktop is not running, or ports `5433`/`6380`/`9000` are taken.                                                                                       |
| `pnpm dev` cannot reach the database                            | `.env` is missing or containers are down: run `pnpm setup` or `pnpm dev:infra`.                                                                               |
| API logs "registry services unavailable; asset routes disabled" | `SECRET_QR_TOKEN_SIGNING_KEY` is unset. Copy the dev value from `.env.example` into `.env` and restart; the QR signer is required for registry/verify routes. |
| Login fails                                                     | Use the exact slug (`alpha-state`), and confirm `pnpm setup --seed`/`pnpm db:seed` ran.                                                                       |
| Dashboard requests fail with 404/502                            | The API is not on `:3000`; start it with `pnpm dev` or the API filter command above.                                                                          |
| No reconciliation runs yet                                      | The worker schedules them from the tenant cron; Reports and Audit show data already.                                                                          |
| Port already in use                                             | Stop the conflicting process, or change `API_PORT` in `.env` and the Vite `server.port` in `apps/{admin,field,collector}/vite.config.ts`.                     |
| A migration check fails                                         | A migration's `down()` is not reversible; fix it before merging.                                                                                              |
| `pnpm install` warns about blocked build scripts                | Only `esbuild` is allowed by pnpm 11; the warning is expected.                                                                                                |
| Ctrl+C does not stop the dev servers                            | Use `pnpm dev` (the supervisor), not `pnpm dev:turbo`: see [Stopping the dev servers](#stopping-the-dev-servers).                                             |

### Stopping the dev servers

`pnpm dev` runs `scripts/dev.mjs`, which spawns the four dev servers directly
(`node` + `tsx`/`vite`, no shell and no package-manager shim) and kills their
process trees on the first Ctrl+C. A second Ctrl+C exits immediately.

`pnpm dev:turbo` still runs the turbo pipeline. On Windows that needs two
Ctrl+C presses: turbo 2.10+ forwards the signal and waits for each task, and the
`cmd.exe` batch wrapper pnpm uses does not exit on the first one, so turbo keeps
printing "4 tasks shutting down…". If you forced it, check for orphans holding
the ports before restarting:

```sh
netstat -ano | grep LISTENING | grep -E ":3000|:5173|:5174|:5175"
taskkill //PID <pid> //T //F
```

### Signed out on every reload

Symptom: you sign in, reload, and land back on the login form, with
`POST /v1/auth/refresh` returning `401` in the console. The browser has no usable
`tpirs_refresh` cookie.

1. DevTools → **Application** → **Cookies** → `http://localhost:5173`. After a
   successful sign-in there must be one live `tpirs_refresh` row with
   `Path /v1/auth/refresh`, `HttpOnly` ticked, and `Secure` blank. An empty row
   with `path=/` is a tombstone left by an old cleared cookie.
2. If the row is missing or stale: **Application → Storage → Storage → Clear
   site data**, then sign in again. Chrome refuses to let an insecure origin
   overwrite an existing `Secure` cookie of the same name and path, so a cookie
   left over from an earlier HTTPS-only build survives sign-in and keeps sending
   a rotated token.
3. Use `http://localhost:5173` exactly — the cookie is host-scoped, so
   `127.0.0.1:5173` is a different jar.
4. `Secure` is set only when `NODE_ENV=production`; over plain `http://localhost`
   browsers drop a `Secure` cookie, which also produced this loop.

If the cookie is present, live, and still returns `401`, check the response body:
"Refresh token is unknown, expired, or revoked" means it was rotated elsewhere (a
second tab), while "Refresh token is missing" means the request carried no cookie
at all.

## 9. What runs where (and why)

The dev compose file (`infra/docker-compose.yml`) contains only infrastructure:
Postgres, Redis, SeaweedFS and a one-shot bucket initialiser. The API, the worker
and all three UIs run on the host so edits hot-reload.

There is no dashboard container in the dev profile. The staging compose
(`infra/docker-compose.staging.yml`) builds the API image from
`infra/docker/app.Dockerfile` for CI smoke tests; the dashboard is a static
build served separately in production.

All tenant behaviour — currency, timezone, fees, channels, cash rules,
reconciliation schedule and tolerances, anomaly rules, statement columns — comes
from tenant config. If you want a third tenant, copy
`tenants/_template/tenant.config.yaml`, validate it, and create the tenant row;
no code changes are involved.
