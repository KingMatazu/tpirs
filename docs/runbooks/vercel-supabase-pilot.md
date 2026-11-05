# Runbook: a Vercel + Supabase team pilot

This is the fastest way to put the system in front of a team: three static UIs
and the API on Vercel, Postgres on Supabase, no background worker. It is a
**pilot topology**, not the production shape: there is no worker, so scheduled
reconciliation and automatic cash freezes do not run, and object storage is
process-local.

```
Vercel project tpirs-admin     ─┐
Vercel project tpirs-field     ─┼─► https://tpirs-api.vercel.app ─► Supabase Postgres
Vercel project tpirs-collector ─┘        (Fastify on Vercel Functions)
```

The frontends use `VITE_API_BASE_URL`, so the API is a different origin. That is
why CORS and a `SameSite=None` refresh cookie are configured below (ADR 0052).

## 1. Supabase

1. Create a project and choose the region closest to your users. Save the
   database password.
2. In **Connect**, copy two connection strings:

| Use                | Port | Why                                                              |
| ------------------ | ---- | ---------------------------------------------------------------- |
| Migrations (local) | 5432 | Session mode; DDL and `SET ROLE` need a normal session           |
| Runtime (Vercel)   | 6543 | Transaction pooler; many short-lived function instances share it |

Both need `sslmode=require`; the password must be URL-encoded if it contains
symbols.

3. Apply the schema **from your machine**, not from Vercel:

```sh
export DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require'
pnpm --filter @tpirs/db migrate up
```

Do **not** run `pnpm setup`: it starts local Docker and is for development. Do
not run `pnpm db:seed` either — the demo tenants contain passwords from the
repository, and this deployment should start empty.

The migrations create the `tpirs_app` role and (migration 0021) grant it to the
role that applied them, so `SET LOCAL ROLE` works on a managed Postgres where the
deploying role is not a superuser. If every request fails with a permission error
on `tpirs_app`, that grant is the first thing to check.

## 2. API project on Vercel

Import the repository as a new Vercel project:

| Setting          | Value                                            |
| ---------------- | ------------------------------------------------ |
| Root Directory   | `apps/api`                                       |
| Framework Preset | Fastify (auto-detected)                          |
| Build            | `apps/api/vercel.json` (`pnpm --filter … build`) |
| Region           | the same region as Supabase, if offered          |

Environment variables (Production, and Preview if you want previews):

| Variable                      | Value                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                | the **port 6543** pooler URL with `?sslmode=require`                          |
| `DB_POOL_MAX`                 | `1`                                                                           |
| `SECRET_QR_TOKEN_SIGNING_KEY` | a new random secret, 32+ bytes; rotating it invalidates printed stickers      |
| `SETUP_TOKEN`                 | a new random secret; **required**, or production refuses first-run setup      |
| `CORS_ORIGINS`                | the three frontend origins, comma-separated (set after step 3, then redeploy) |
| `REFRESH_COOKIE_SAMESITE`     | `none`                                                                        |
| `TRUST_PROXY`                 | `true`                                                                        |
| `OBJECT_STORAGE_ADAPTER`      | `mock` (see step 7)                                                           |
| `METRICS_ENABLED`             | `false`                                                                       |
| `REQUIRE_STAFF_TOTP`          | `false`                                                                       |
| `DEPLOYMENT_REGION`           | e.g. `katsina-pilot`                                                          |

`NODE_ENV` is `production` on Vercel; that is what makes the refresh cookie
`Secure`, and what makes an unset `SETUP_TOKEN` disable setup. Do not override it.

Deploy, then check:

```sh
curl -fsS https://<api>.vercel.app/v1/health
curl -fsS https://<api>.vercel.app/v1/ready
```

If the build fails on pnpm, set `ENABLE_EXPERIMENTAL_COREPACK=1` for that project;
Vercel then uses the `packageManager` field in `package.json`.

## 3. Frontend projects on Vercel

Create three more projects from the same repository:

| Project           | Root Directory   | Build config                 | Environment variable                                                 |
| ----------------- | ---------------- | ---------------------------- | -------------------------------------------------------------------- |
| `tpirs-admin`     | `apps/admin`     | `apps/admin/vercel.json`     | `VITE_API_BASE_URL=https://<api>` plus the three app addresses below |
| `tpirs-field`     | `apps/field`     | `apps/field/vercel.json`     | `VITE_API_BASE_URL=https://<api>`                                    |
| `tpirs-collector` | `apps/collector` | `apps/collector/vercel.json` | `VITE_API_BASE_URL=https://<api>`                                    |

The `VITE_API_BASE_URL` value must match the API origin exactly (scheme + host,
no trailing slash). It is read at build time, so set it before the first build
and redeploy after changing it. Each build also builds the workspace packages it
imports (`pnpm --filter @tpirs/<app>... build`).

`tpirs-admin` also carries the addresses the account handover card prints, so an
administrator can tell a new officer where to sign in:

```sh
VITE_ADMIN_APP_URL=https://tpirs-admin.vercel.app
VITE_FIELD_APP_URL=https://tpirs-field.vercel.app
VITE_COLLECTOR_APP_URL=https://tpirs-collector.vercel.app
```

`VITE_ADMIN_APP_URL` is optional (the dashboard defaults to the origin serving
it). The other two are not: unset, the card says "not configured in this build"
and names the variable, rather than linking nowhere. All three are build-time
values, so changing one means redeploying `tpirs-admin`.

The PWA service workers are scoped to each project's domain; installing the
officer and collector apps works the same as locally.

## 4. Close the CORS loop

Take the three production URLs and set them on the **API** project:

```sh
CORS_ORIGINS=https://tpirs-admin.vercel.app,https://tpirs-field.vercel.app,https://tpirs-collector.vercel.app
```

Redeploy the API so the allowlist is active. Rules:

- Exact origins, no trailing slash, no `*`.
- A preview deployment has a different origin. Add its URL temporarily (or test
  only the production deployment); otherwise the browser blocks it.
- The refresh cookie is `HttpOnly` and scoped to `/v1/auth/refresh`. If it is
  missing, sign-in works but every reload returns to the login form. Check in
  this order: `Set-Cookie` on the login response, the origin in `CORS_ORIGINS`,
  and `VITE_API_BASE_URL`.

### The cookie depends on the domain shape

| Shape                                  | `REFRESH_COOKIE_SAMESITE` | Why                                                                  |
| -------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `*.vercel.app` subdomains (cross-site) | `none`                    | `vercel.app` is a public suffix, so the projects are different sites |
| `levy.example.gov` + `api.example.gov` | `strict`                  | same registrable domain, so the cookie is same-site                  |

`SameSite=None` cookies are third-party cookies. Safari blocks them by default,
and a locked-down Chrome profile can too; sign-in still works, but a reload falls
back to the login form. If the team uses Safari, put both apps under one custom
domain (the second row) or front the API with a same-origin Vercel rewrite.

## 5. First run

Open:

```
https://tpirs-admin.vercel.app/?setupToken=<SETUP_TOKEN>
```

The wizard creates the tenant, its seven roles, the first account and no zones;
step 4 replaces `admin` / `password` with your own credentials and signs you in.
After that `POST /v1/setup/tenant` returns `404` even with the token.

Then:

1. **Zones** — create the operating zones, or leave the list empty.
2. **Users** — create the team's accounts with temporary passwords and roles. The
   first role is the **primary** one — the job the person was hired for — and the
   **Additional roles** panel adds extra access on top. A collector account also
   needs a phone number, national ID and home address, which the form asks for as
   soon as Collector appears anywhere in the role set, primary or extra.
3. **Registry** — register one vehicle and download its sticker for a smoke test.
4. Rotate or remove `SETUP_TOKEN` from the API project. It is unused after the
   first tenant exists, but there is no reason to keep a live secret around.

### Handing over an account

An account created in **Accounts → Add an account** starts with a temporary
password the server will not let anyone keep. The screen produces a card at the
moment the account is created — and again after a password reset — containing:

- the app address for the roles chosen: officer → officer app, collector →
  collector app, everything else → dashboard;
- the state slug, which every sign-in form asks for;
- the username and the temporary password.

**Copy handover text** writes all of it as one message (paste it into WhatsApp, or
read it down a phone). **Print or save as PDF** prints the card on its own — not
the dashboard around it — and "Save as PDF" in the browser's print dialog is the
PDF copy. **Generate** fills a readable 16-character password, so nobody has to
invent one under time pressure.

A collector account also carries the person's phone number, national ID and home
address. The form asks for them when Collector appears anywhere in the role set —
primary or an additional role — and refuses the account without them; the ID's
format is the state's own rule (`collectors.nationalIdPattern`, eleven digits in
the template). The three values are shown on the account row, and none of them is
written to the audit trail.

**Edit roles** on an account row uses the same picker as the create form: the
primary role as a radio, every other role as a checkbox behind the **Additional
roles** button. Clearing a checkbox and saving takes that access away, which is
how a supervisor who has moved off cash handling stops being a collector. The
primary role itself cannot be removed — choose a different one, or disable the
account.

The form masks the password as you type it; **Show** reveals it so you can check
what you generated before submitting, and **Hide** puts it back. The card is the
only place the password appears afterwards: the server stores a hash, so closing
it loses the value. Re-opening it from the **Handover** button on the account row
shows everything except the password — a password that has already been handed
over cannot be read back, so that card offers **Set a new temporary password**
instead. It issues a fresh one, puts it on the card, and stops the old one
working.

What the person does:

1. Open the address on the card.
2. Enter the state, the username and the temporary password.
3. Choose their own password. That screen is the only thing they can reach until
   they do, and the username stays exactly as handed over.
4. The temporary password stops working and any other session it created ends.

If the card is lost, an administrator resets the password from the same screen;
the reset re-flags the account and produces a new card.

Accounts created **before** this change are still flagged and were previously
unusable on the officer and collector apps. They now reach the password screen on
their next sign-in; nothing needs to be reset.

### Removing an account

**Accounts → Delete** on an account row (not your own) removes it after a
confirmation. It is a tombstone, not a hard delete (ADR 0062): the login, personal
details, roles and sessions go, the account disappears from the list, and the
username becomes free again — but the row stays so the audit trail and any money
movement still resolve the person who made it. The confirmation says this, and the
toast repeats it.

Two refusals are deliberate: your own account, and the last active system
administrator. Give someone else the role before deleting that one.

The **Driver** role is not offered when adding an account: drivers are registered
in the Registry, not as logins. An account that already holds the role still shows
it under **Edit roles**, so the grant can be removed.

### Recovering the administrator who created the tenant

There is no email sender yet, so a forgotten administrator password has two
temporary ways back (ADR 0060). Both are removed when password reset by email
ships.

**Still signed in somewhere.** Accounts → **My password** → type or **Generate for
me** a temporary password → **Set temporary password**. Every other session ends,
and the app immediately asks you to choose a real one.

**Signed out everywhere.** Call the setup route with the deployment's
`SETUP_TOKEN` (the same secret the first-run wizard uses):

```sh
curl -sS -X POST https://tpirs.vercel.app/v1/setup/admin-password \
  -H 'content-type: application/json' \
  -H "x-setup-token: $SETUP_TOKEN" \
  -d '{"tenantSlug":"katsina-state"}'
```

It answers with the username and a new temporary password for the tenant's first
system administrator, ends that account's sessions, and returns `503` if the
deployment has no `SETUP_TOKEN` — so set one before you need it. The password is
shown once; sign in, choose a real one, and treat the response as a secret.

### Adding drivers and printing stickers

Registration belongs to the dashboard, not the collector app (ADR 0058).

1. Registry → **Add a driver**: full name, phone, plate, optional email, and the
   vehicle type when the state has more than one. There is no password: a driver
   is an owner plus a vehicle and pays with the short code.
2. The sticker appears straight after **Register driver**, with **Print sticker**
   (prints the QR and the short code alone), **Show sticker** and **Download
   sticker**. The same panel is on every asset's detail, so a sticker can be
   reprinted later.
3. A zone supervisor only sees the form for their own zone, and the server refuses
   a vehicle in another zone. A system admin may leave a vehicle unzoned.

The fee shown when taking cash is the state's, not the collector's: neither the
collector app nor the dashboard has an amount field (ADR 0059). Changing a fee is
a tenant config change by a system admin.

### Installing the collector app

The collector app is an installable PWA. On the handset:

1. Open the collector address and sign in.
2. Tap the collector's initials in the Home header to open **Profile**.
3. **Android/Chrome:** tap **Install on this phone**. **iPhone/iPad:** tap Share,
   then **Add to Home Screen** (Safari exposes no install prompt).

The Profile screen says which case applies. If it offers the browser menu
instead, that browser never emitted an install prompt — open the address in
Chrome or Safari rather than an in-app webview. The installed app opens full
screen; its shell is cached, but taking cash still needs a connection, because
nothing is recorded on the phone.

### What a collector sees in Profile

The initials in the Home header open a read-only profile:

- name, role, username and the state;
- the collector's own phone, national ID and home address, with the ID masked to
  its last four digits until **Show** is tapped. These fields are managed in the
  dashboard, not in the app;
- cash in hand against the float ceiling, with a frozen warning;
- the install row;
- **Sign out**, which moved here from Home.

There is no self-service password change yet. A collector who needs one asks a
supervisor, who resets it from **Accounts**; the reset re-flags the account and
produces a new handover card.

## 6. What does not run without the worker

The Vercel pilot deliberately has no `apps/worker`. As a result:

| Feature                                      | Behaviour without the worker                     |
| -------------------------------------------- | ------------------------------------------------ |
| SMS receipts / queued channel replies        | queued in the outbox, never sent                 |
| Automatic collector freeze on missed deposit | does not happen; freeze manually from Collectors |
| Nightly reconciliation schedule              | does not run                                     |
| Reconciliation job queue                     | jobs would sit in the queue                      |

Owner phone verification is also unavailable in this topology: the OTP service
uses the composition root's mock SMS provider and the mock cache, so no code is
delivered and a code sent on one function instance is gone on the next. Register
owners without phone verification for the pilot; verify phones once a real SMS
provider and a shared cache are configured.

USSD menus, login, onboarding, registry, verification, payments, disputes,
manual cash intake and reports in the UI all work, because they are request/response.

To keep the pilot's background jobs moving, run the worker **from a laptop**
against the same Supabase database while the team tests:

```sh
export DATABASE_URL='postgresql://…:6543/postgres?sslmode=require'
export DB_POOL_MAX=2
pnpm --filter @tpirs/worker dev
```

The worker uses the Postgres job queue (no Redis needed) and the mock SMS
provider, so no messages leave the machine. Stop the laptop and the schedule
stops; this is a workaround, not a deployment.

## 7. Object storage

`OBJECT_STORAGE_ADAPTER=mock` keeps uploads in the function instance's memory.
Photo uploads appear to succeed, but a later read can 404 after the instance
recycles, and report exports that rely on stored files are not durable. Sticker
rendering is in-memory and works.

For durable uploads, point the existing S3 adapter at any S3-compatible bucket
(Supabase Storage's S3 endpoint, Cloudflare R2, AWS S3) and set:

```
OBJECT_STORAGE_ADAPTER=s3
OBJECT_STORAGE_ENDPOINT=…
OBJECT_STORAGE_REGION=…
OBJECT_STORAGE_BUCKET=…
OBJECT_STORAGE_ACCESS_KEY_ID=…
OBJECT_STORAGE_SECRET_ACCESS_KEY=…
```

No code change is needed; `apps/api/src/storage.ts` is the only selector.

## 8. Pilot safety

- Treat this as test data: do not put real driver personal data or real payments
  through it.
- First-run setup is protected by `SETUP_TOKEN` and by the fact that the window
  closes after one tenant. Never deploy a production API with the token unset and
  no tenant.
- `METRICS_ENABLED=false`: the metrics endpoint is unauthenticated.
- Vercel preview deployments are public by default. Enable Vercel Authentication
  for the project if the team is not the only audience.
- Secrets live only in Vercel/Supabase environment settings. `.env` is gitignored
  and must never be uploaded.

## 9. Troubleshooting

| Symptom                                     | Likely cause / fix                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `permission denied to set role "tpirs_app"` | Migrations ran under a different role; run `grant tpirs_app to <that role>` or re-run 0021                               |
| `self signed certificate` / SSL error       | Missing `?sslmode=require` on `DATABASE_URL`                                                                             |
| `too many connections`                      | `DB_POOL_MAX` above 1, or the direct (5432) URL used at runtime                                                          |
| Login succeeds but a reload signs you out   | Cookie blocked: wrong `CORS_ORIGINS`, `SameSite` still `strict`, or `VITE_API_BASE_URL` mismatch                         |
| Browser CORS error                          | Origin typo/trailing slash; redeploy the API after changing `CORS_ORIGINS`                                               |
| Setup answers `503 setup_disabled`          | `SETUP_TOKEN` unset while `NODE_ENV=production`; set it and redeploy                                                     |
| Setup answers `401 setup_token_required`    | Missing/wrong `?setupToken=`; the token is the `SETUP_TOKEN` value                                                       |
| Function timeout during onboarding          | Onboarding is normally sub-second; raise the project's function duration in Vercel settings if a report export times out |
| Build cannot find `@tpirs/*`                | Root Directory wrong, or the build command did not build workspace dependencies                                          |

## 10. Resetting the data for a demo

A demo reset empties the application's tables and leaves the schema, roles and
migrations in place. The dashboard then shows the **first-run wizard** again,
because "setup is required" simply means "no tenants" (ADR 0064).

**Before you wipe:**

1. **Know the `SETUP_TOKEN`.** This deployment has one, so the wizard asks for it.
   If it is lost, the zero-tenant window is closed to you as well.
2. Take a backup if the current data matters — Supabase's dashboard has Backups
   (paid plans also have point-in-time recovery). The reset cannot be undone from
   the app.
3. Expect to be signed out of everything: the accounts are part of the data.

### Option A — Supabase SQL editor (no local tooling)

Paste this into **SQL Editor** and run it. It truncates every table in `public`
except Kysely's migration record, which must survive or the next migrate would
try to create tables that already exist:

```sql
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename not in ('kysely_migration', 'kysely_migration_lock')
  loop
    execute format('truncate table public.%I cascade', t);
  end loop;
end $$;

alter sequence if exists asset_short_code_seq restart with 1000;

select
  (select count(*) from tenants) as tenants,
  (select count(*) from users) as users,
  (select count(*) from assets) as assets;
```

The last query should return `0, 0, 0`. Supabase's own schemas (`auth`,
`storage`) are not touched, and neither are the `tpirs_app` role or its grants.

### Option B — from the repo

```sh
DATABASE_URL='postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true' \
  pnpm db:reset-demo          # prints what it would remove
DATABASE_URL='…same…' pnpm db:reset-demo --yes
```

Without `--yes` it only reports the target and the row counts. The truncate runs
in one transaction.

### After the wipe

1. Reload the dashboard: it shows **Set up your state**. Complete the wizard (it
   asks for the `SETUP_TOKEN`) and you are the new system administrator with a
   temporary password.
2. The short-code sequence is back at 1000, so the first registered driver is
   `B001000` (or the tenant's own prefix).
3. If you would rather demo a populated system than an empty one, create the
   tenant first and then register a handful of drivers from **Registry → Add a
   driver** — the sticker, the cash intake and the reports all follow from that.
