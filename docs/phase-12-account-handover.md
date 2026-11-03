# Phase 12 implementation: staff account handover and first sign-in

A pilot state hires an officer. An administrator opens **Admin → Accounts → Add an
account**, types a temporary password and reads a toast that says "hand over the
temporary password directly". That is where the product stops being usable: the
officer is not told which of the three frontends is theirs, is not told the state
slug their sign-in form asks for, and — on the officer and collector apps — has no
screen that can replace the temporary password at all.

This phase makes handing over an account a single, copyable artefact and makes the
first sign-in work on every domain, not only the dashboard.

## What already exists

| Area                                              | Where                                                   | State       |
| ------------------------------------------------- | ------------------------------------------------------- | ----------- |
| Create / disable / re-role / reset accounts       | `apps/api/src/routes/users.ts` (ADR 0051)               | completed   |
| Temporary password flag, no-self-edit rules       | `packages/application/src/user-service.ts`              | completed   |
| Server-side gate on a flagged account             | `enforceCredentialRotation()` in `apps/api/src/auth.ts` | completed   |
| First-sign-in credential form (dashboard)         | `apps/admin/src/pages/CredentialForm.tsx`               | completed   |
| Account list and create form                      | `apps/admin/src/pages/UsersPage.tsx`                    | completed   |
| Tenant slug available to the dashboard            | `useTenantConfig()` → `identity.slug`                   | completed   |
| First-sign-in screen in the officer app           | —                                                       | **missing** |
| First-sign-in screen in the collector app         | —                                                       | **missing** |
| Password-only rotation route                      | —                                                       | **missing** |
| Handover artefact (URL, slug, username, password) | —                                                       | **missing** |

## The gap, precisely

`enforceCredentialRotation()` refuses every route except `auth/me`,
`auth/refresh`, `auth/logout` and `auth/complete-onboarding` while
`mustChangeCredentials` is set. The dashboard handles that: `App.tsx` renders
`CredentialForm` and nothing else. `apps/field` and `apps/collector` do not — they
store `userId`, `tenantId`, `displayName` and `permissions`, and go straight from
"authenticated" to the home screen. A newly created officer therefore signs in and
every screen fails with `403 must_change_credentials`, rendered as a generic error.
Only an account that can reach the dashboard can finish rotation, and an officer
cannot.

`complete-onboarding` is not the answer for staff: it forces a **username** change
because the provisioning account is literally called `admin` with the password
`password`. A staff account was given a real username by the administrator, so
sending the person back to invent a new one contradicts the handover card they are
holding.

## Scope decisions

- **Password-only rotation for staff.** A new route,
  `POST /v1/auth/change-password`, authenticated, available only while the flag is
  set (404 afterwards, exactly like `complete-onboarding`). It keeps the username,
  replaces the hash, clears the flag, ends the account's other sessions and keeps
  the caller's. `complete-onboarding` stays as the wizard's own end, unchanged.
- **The three app addresses are deployment settings, not tenant settings.** One
  deployment serves every tenant on the same three frontends, so
  `VITE_ADMIN_APP_URL`, `VITE_FIELD_APP_URL` and `VITE_COLLECTOR_APP_URL` are set
  on the admin project at build time. The admin URL defaults to
  `window.location.origin`; an unset field/collector URL renders "not configured in
  this build" rather than a dead link. Moving these into the tenant config is
  deferred (below) — it is the right answer for a resold product with per-state
  domains, and the wrong amount of change for a pilot.
- **The state slug comes from the tenant config the dashboard already holds.** No
  new endpoint, and no chance of the card disagreeing with what the login form
  expects.
- **The temporary password is generated, not typed.** A 16-character value from
  `crypto.getRandomValues` behind a **Generate** button, still overridable. Weak
  temporary passwords are the failure mode that makes the flag pointless.
- **The password is shown once, and only to the administrator who set it.** The
  server never returns it, so the handover card exists in memory only for the
  create/reset that produced it. Re-opening it later shows everything except the
  password.

## Step 1: Password-only rotation (delivered)

- `packages/db/src/repositories/user.ts`: `changePassword(id, passwordHash)` — sets
  the hash and clears the flag in one statement, mirroring `setTemporaryPassword`.
- `packages/application/src/user-service.ts`: `changeOwnPassword()` — validates
  against **that account's** username, writes, revokes every session for the user
  except the caller's, and records `auth.credentials_changed` (username and flag,
  never the hash).
- `apps/api/src/routes/auth.ts`: `POST /v1/auth/change-password`, plus its entry in
  `CREDENTIAL_ROTATION_ROUTES` — without it the gate blocks the route that exists
  to satisfy the gate.
- Regenerate the contract: `pnpm --filter @tpirs/api build` →
  `pnpm --filter @tpirs/api-client build`.

## Step 2: First sign-in on the officer and collector apps (delivered)

- Both sessions read `mustChangeCredentials` from login and `/v1/auth/me`.
- New `screens/SetPasswordScreen.tsx` in each app (local copies, matching how these
  two apps share nothing but tokens): new password, confirmation, show/hide, the
  six-character rule inline, and sign-out as the way out.
- `App.tsx` in both renders that screen before any other while the flag is set.

## Step 3: The handover card (delivered)

- `apps/admin/src/lib/appLinks.ts`: resolves the three destinations from
  `import.meta.env`, admin defaulting to the current origin.
- `apps/admin/src/pages/HandoverCard.tsx`: destination app(s) by role
  (`officer` → field, `collector` → collector, anything else → dashboard), then
  app address, state slug, username and temporary password, each copyable, plus
  **Copy handover text** and **Print**.
- `UsersPage.tsx`: render the card after create and after reset (the only two
  moments the password is known), a **Handover** row action while the flag is set,
  and **Generate** on the temporary-password field.

## Step 4: Tests (delivered)

- `apps/api/src/routes/users.routes.test.ts`: a weak replacement is refused with a
  `password` issue and leaves the account flagged; a flagged account rotates, the
  old token dies, the replacement token works, the temporary password stops
  signing in, the username is unchanged, a second call answers 404, and the audit
  trail records `auth.credentials_changed` without any password.
- `apps/api/src/routes/access-matrix.test.ts`: the new route is classified as
  authenticated-without-permission, so the matrix stays complete.
- `UsersPage.test.tsx`: the card names the officer app and the state for an
  officer, the dashboard address for a finance role, explains an unset address,
  drops the password when dismissed, reopens without it, and generates one.
- `appLinks.test.ts`, `temporaryPassword.test.ts`: the mapping and the message.
- `SetPasswordScreen` tests and an `App` branch test in both phone apps.

Verified with the repository's own gates: `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and the DB-backed suite against local Postgres
(`TEST_DATABASE_URL=postgres://tpirs:tpirs@localhost:5433/tpirs`), where
`@tpirs/api` reports 116 passing. Running every package at once against one
Postgres on this machine produced timeouts in unrelated suites; each package is
green on its own, which is the same contention `scripts/ci/integration.sh`
avoids by using a scratch database.

## Step 5: Documentation (planned)

- `docs/runbooks/vercel-supabase-pilot.md`: a "Handing over an account" section
  with the exact words an administrator reads out, and the two Vercel variables.
- `docs/adr/0053-staff-first-sign-in.md`: why staff rotation is password-only and
  why the addresses are build-time settings.

## Acceptance checks

1. An administrator creates an officer account and the card names the officer app,
   the state slug, the username and the password, all copyable in one action.
2. That officer opens the named address, signs in with the temporary password, is
   shown the password screen and nothing else, sets a password, and lands on the
   home screen without signing in again.
3. The temporary password stops working; the account's other sessions are gone.
4. The same flow passes on the collector app for a collector account.
5. A dashboard account still completes rotation through `CredentialForm`, and
   `complete-onboarding` still renames the provisioning account.
6. With `VITE_FIELD_APP_URL` unset the card says so instead of linking nowhere.

## Deferred

- **App addresses in tenant config.** Needed when one deployment serves several
  states with their own domains; today a redeploy of the admin project is cheaper
  than a schema, validator, template and config-viewer change.
- **Emailed invitations.** There is no mail sender; the handover is deliberately
  in person or over the operator's own channel.
- **TOTP enrolment on first sign-in.** The officer app still signs in with a
  password only; staff two-factor for field devices remains the Phase 6/10 gap it
  already was.
