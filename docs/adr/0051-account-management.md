# ADR 0051: Account management is administrator-only, temporary-password first, and never self-service

## Status

Accepted

## Context

Phase 11 needs a state to run its own staff without a SQL editor: hire an
officer, disable someone who left, give back access to a lost password. There is
no mail sender yet, so a reset cannot be a link — someone with `user:manage` has
to set a new password and hand it over.

That shape creates three hazards worth deciding deliberately:

1. An administrator who can edit roles can grant themselves any permission in
   the tenant, including ones they were denied on purpose.
2. A password set by someone else is known to someone else.
3. A session issued before a reset keeps working after it.

## Decision

- **Accounts are created with a temporary password.** `POST /v1/users` takes the
  password an administrator will hand over and stores the account with
  `must_change_credentials = true`. The credential gate from ADR 0049 applies to
  every account, not just the first one: the first sign-in can only replace the
  password, and the replacement cannot be the username or `password`.
- **A reset is also temporary.** `POST /v1/users/:id/password` sets a new hash,
  re-flags the account, and revokes every live session **in the same
  transaction**. A reset that leaves old sessions working is not a reset, and
  ending sessions in a second call is a window an attacker keeps.
- **No self-service.** An administrator cannot change their own roles, status or
  password through these routes. Self-escalation is the one change an audit trail
  cannot distinguish from a legitimate one, and a lost administrator is a
  two-person problem by design; a second administrator exists in every tenant
  that has more than one.
- **Disabling is immediate.** `status = 'disabled'` is already checked when a
  session is resolved, so a disabled account cannot use a token it already
  holds; no extra revocation step is needed for correctness (the reset path
  still revokes, because its hazard is the password).
- **Roles are validated, not silently dropped.** A role key the tenant does not
  define is a `422` on `roleKeys`; a caller that sends a typo gets an error, not
  an account with fewer permissions than intended.
- **No credentials in the trail.** The service returns summaries that cannot
  carry a hash, and the routes' audit descriptors name only the account, status
  and role keys. A test asserts no password text appears in any audit row.

## Consequences

- Two administrators are required to change an administrator's own access. This
  is a deliberate cost.
- Every account starts locked into the credential step, so the temporary
  password cannot become a permanent one.
- When a mail sender arrives, the reset flow becomes a token link and this route
  stays for the "hand it over in person" case rather than being replaced.
