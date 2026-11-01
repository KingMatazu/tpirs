# ADR 0049: First-run setup closes permanently, and the provisioning account does one thing

## Status

Accepted

## Context

A fresh deployment had no way to create a tenant: `repositories.tenants.create()`
was called only by the demo seed, so the login form on an empty database was a
dead end. Phase 11 makes onboarding a web flow — a state official opens the
dashboard, answers a wizard, and lands signed in.

That creates two problems a normal authentication design does not have:

1. **There is no account yet to authenticate the creation with.** Something has
   to be callable by an unauthenticated caller, on a server that may already be
   reachable.
2. **The first account is created before anyone has chosen credentials for it.**
   Some password must exist between "tenant created" and "administrator chose a
   username and password", and whatever it is, it is knowable.

Options considered for (1):

- **A `SETUP_TOKEN` printed to the log or the console** and pasted into the
  wizard. Rejected: it is a step an operator performs exactly once, on the day
  they are least practised at it, and it fails in the direction that hurts —
  either it is not set (setup is impossible) or it is left in a shell history.
- **A CLI provisioner** (`tenant:create`). Rejected for the first tenant: the
  brief's acceptance check is that someone who has not seen the code can onboard
  a state, and a CLI is a second interface to design, document and keep in sync
  with the config schema.
- **Close the window instead of guarding it.** The endpoints exist only while the
  deployment has zero tenants. After that they answer `404`, exactly like a route
  that was never registered, so a configured deployment exposes nothing to
  probe. Operationally this is one instruction: run setup before exposing the
  port.

Options considered for (2):

- **Make `/v1/setup/complete` unauthenticated**, taking the new credentials in
  one request. Rejected: it turns the window into a race where any caller who
  arrives first owns the tenant, with nothing to distinguish them.
- **Issue a normal session for the temporary account and rely on the UI** to send
  the user to the credential screen. Rejected: a temporary password is not a weak
  password, it is a published one. Until it is replaced the account has no
  secret at all, so the useful posture is to let it do one thing rather than to
  let it in and recommend otherwise.
- **Confine it server-side to the routes that replace its credentials.** The
  session is real, but every other route answers `403 must_change_credentials`,
  and finishing onboarding returns a session for the account's own credentials so
  the person is not asked to type them again.

## Decision

- **`GET /v1/setup/status` and `POST /v1/setup/tenant` are unauthenticated and
  exist only while the deployment has no tenant.** Both answer `404` afterwards.
  Both are rate limited like login.
- **No `SETUP_TOKEN` in this phase.** Deferred until a deployment is
  internet-facing or hosts several tenants.
- **Provisioning creates the first account as `admin` / `password`** with
  `must_change_credentials` set, and `startOnboarding` refuses to be the path
  that leaves it that way in production without the wizard.
- **`must_change_credentials` lives on the account and travels with the
  principal.** `apps/api/src/auth.ts` resolves it on every request from the
  `users` row — not from the token — so a session minted before the flag clears
  cannot outlive the gate it was issued under.
- **Only `POST /v1/auth/complete-onboarding`, `POST /v1/auth/logout`,
  `POST /v1/auth/refresh` and `GET /v1/auth/me` are reachable** while the flag is
  set. The last two exist so a browser that reloads mid-onboarding is told what
  to do rather than signed out into a login form it cannot use.
- **`POST /v1/auth/complete-onboarding` is the end of onboarding, not a
  credential-change screen.** It is authenticated by the temporary session,
  accepts only a new username and password, clears the flag in the same
  statement, revokes the temporary session, and returns a session for the new
  credentials.
- **The responses carry `mustChangeCredentials`** (`/v1/auth/me`, login, refresh)
  so a client can route on it, and `403 must_change_credentials` carries its own
  error code so a client can tell "finish onboarding" from "you lack permission".

## Consequences

- A deployment is anonymous-configurable exactly once, for as long as it takes to
  complete a four-step form. The alternative — a permanent endpoint guarded by a
  secret someone has to keep — is a worse answer for the first deployment and can
  be revisited when there is more than one tenant per deployment to guard.
- The gate is enforced per request, so it applies to every route that will ever
  be added, including ones written by someone who never read this record.
- Every authenticated request now reads the account row (a primary-key lookup)
  in the transaction it already opened for permissions. That is the price of
  judging the account rather than the token.
- A deployment that is exposed before setup is complete can be claimed by anyone
  who reaches it first. That is stated in the onboarding runbook rather than
  papered over: the mitigation is the deployment order, not a token.
- If setup is abandoned, there is no way to restart it without emptying the
  database — the tenant exists, so the window is shut. The runbook says so, and
  `pnpm setup` (fresh install, no seed) is the supported way back.

## Alternatives considered

- **`SETUP_TOKEN` environment variable** — rejected above; revisitable when a
  deployment hosts several tenants and setup becomes a recurring operation.
- **Unauthenticated completion route** — rejected: it hands the tenant to whoever
  arrives first.
- **A separate `setup` role or permission** — rejected: this is not an
  authorisation decision an operator can grant, it is the shape of the handshake,
  and a permission would have to be granted to an account that does not exist
  yet.
