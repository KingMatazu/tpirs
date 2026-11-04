# ADR 0060: A locked-out administrator recovers with a temporary password, for now

## Status

Accepted — **temporary**. Removed when password reset by email exists.

## Context

There is no email provider in the deployment, so there is no forgot-password
flow, and two accounts have no way back in:

1. The administrator who created the tenant. `POST /v1/users/:id/password`
   refuses self-resets (`assertNotSelf`), so nobody can reset the creator except
   another administrator — and on a pilot there is no other administrator.
2. The same person after they have signed in but forgotten the password on
   another device.

The existing self-service route (`POST /v1/auth/change-password`) only works while
an account is flagged with `mustChangeCredentials`; once the person has chosen a
real password it answers 404 by design.

## Decision

Two paths, both marked temporary in code and in this record:

- **Signed-in self-reset.** `POST /v1/auth/temporary-password` requires
  `user:manage` and touches only the caller's own account. It sets a new password,
  sets `mustChangeCredentials`, revokes every session for the account, audits
  `user.password.self_reissued`, and returns a session for the now-flagged account
  so the app sends the caller straight to the credential step. The Accounts screen
  offers it as a "My password" card with Show/Hide and Generate.
- **Locked-out recovery.** `POST /v1/setup/admin-password` is gated by the
  deployment's `SETUP_TOKEN` in **every** environment, and answers `503` when the
  token is unset — including in development. It re-issues the password of the
  tenant's **first** `system_admin` (ordered by `created_at`, so a renamed
  provisioning account is still the creator), ends its sessions, and returns the
  generated password once. The audit row names the setup token as the source and
  records neither the token nor the password.

## Consequences

- Possession of `SETUP_TOKEN` can reset the tenant creator's password. That is the
  point, and it is why the route is rate-limited and why the account is identified
  by role and creation order rather than by a username an attacker supplies.
- Both paths are destructive: every session of the target account ends. The UI
  says so before the action.
- The generated password avoids look-alike characters (`0/O`, `1/l/I`) because it
  is read off a screen and typed by hand.
- Removing this is a task, not folklore: the two routes, the "My password" card,
  and the `user.password.self_reissued` / `user.password.setup_reissued` actions
  go when email reset lands. The audit actions stay meaningful either way, which
  is why they are named for what happened rather than for the feature.

## Alternatives considered

- **Relax `assertNotSelf` on the general reset route.** Rejected: that route
  targets any account, and loosening its self-check weakens the rule for every
  administrator, not just the creator.
- **A recovery code printed at setup.** Rejected: another secret to lose, and it
  would have to be stored (hashed) and revoked — more machinery than the token the
  deployment already has.
- **Manual SQL by an operator.** Rejected as the documented path: it is
  unauthenticated in practice (whoever holds the connection string), unaudited in
  the application trail, and easy to get wrong.
