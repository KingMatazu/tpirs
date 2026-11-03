# ADR 0055: One role per person is primary, and extra roles are revocable

## Status

Accepted

## Context

Roles are a set. `user_roles` is a join table with a `(user_id, role_id)` primary
key, `POST /v1/users` takes a `roleKeys` array, and a session's permissions are the
union of every role the account holds. That is the right model for access — a zone
supervisor who also collects cash genuinely needs both.

Operators do not think in sets. A person is hired as an officer, or as a collector,
and the dashboard's account form first shipped as independent checkboxes, so
ticking Collector and Auditor produced an account with both: a state the screen
did not describe and the operator did not intend. The form was changed to a radio
group, which fixed the accident but created a new problem — the role set the API
still accepts can be wider than the one role the form can express, so the "Edit
roles" panel had to stay a checkbox set. Saving that panel with a single selection
would silently drop the others, which is an access removal disguised as a
tidy-up. Two screens, two different rules, and no record of which role an account
exists for.

The trigger for deciding this was a request to add a phone number, a national ID
and a home address for collectors (ADR 0054). Those fields are required "for a
collector", and with a set that phrase is ambiguous: does an officer who also
collects need them? Without a primary role there is no way to ask.

## Decision

- **The primary role is stored on the grant.** `user_roles.is_primary` (migration 0023) with a partial unique index on `(user_id) where is_primary`, so "at most
  one primary per person" is a database guarantee rather than a service
  convention. "At least one" is not expressible without a deferred check, so the
  service owns it; a grant written directly by a test or an import may carry none
  and reads as `primaryRoleKey: null`.
- **The contract stays additive.** `POST /v1/users` keeps `roleKeys` as the full
  set and gains an optional `primaryRoleKey`; when it is omitted the first key is
  primary, so a single-role account — the common case, and every existing caller —
  sends nothing new. `PATCH /v1/users/:id` accepts `primaryRoleKey` with or
  without `roleKeys`.
- **A primary role must be one of the roles being assigned.** Sending a key
  outside the list is a `422` naming `primaryRoleKey`, not a silent drop and not
  an implicit grant. Re-labelling alone (`primaryRoleKey` with no `roleKeys`) only
  moves the mark on a grant the account already holds.
- **`UserSummary` returns `primaryRoleKey` and orders `roles` primary first.** The
  account list, the handover card and the edit panel all read that order, so the
  role a person was hired for is the one an administrator sees first.
- **Both screens use one control.** `RolePicker` renders the primary role as a
  radio group and the rest as checkboxes in a panel opened by a button, in the
  create form and in "Edit roles" alike. Extras exclude the primary, so no role
  appears twice; clearing an extra and saving revokes it.
- **Primary grants nothing.** Permissions remain the union of every role. The
  collector profile is still required when the set contains `collector`, not when
  the primary is `collector` — an officer who takes cash needs the details too.

## Consequences

- Revoking an extra role is now a visible, deliberate act on a screen that lists
  every role the account holds. The previous "Edit roles" panel could not safely
  become single-select; it no longer has to be.
- The demo seed and `tenant:create` mark the first role they assign as primary,
  idempotently, so a re-run moves the mark rather than failing the unique index.
- Migration 0023 backfills one primary per existing user (alphabetically first
  role key) so no account is left without one. The backfill is deterministic, so a
  restored dump migrates to the same answer.
- `roleKeysForUser` now sorts. Callers that depended on arbitrary database order
  get a stable one, which is a change in observable output but not in meaning.
- The audit trail records `primaryRoleKey` alongside the role set. It is role
  metadata, not personal data, and a role change without the primary would be a
  half-truth in the trail.

## Alternatives considered

- **Keep roles unordered and let the form's radio be a UI convention.** Rejected:
  the convention is lost on submit, so the edit panel cannot show which role it
  was, and the account list prints roles in whatever order Postgres returns.
- **Replace `roleKeys` with `primaryRoleKey` + `additionalRoleKeys`.** Cleaner to
  read, but a breaking contract change across the generated client, the seed, the
  tests and any integration already sending `roleKeys`, for no gain the additive
  shape does not provide.
- **A `primary_role` column on `users`.** Rejected: the primary is a property of a
  user's assignment of a role, and `user_roles` is already that row. A column on
  `users` could name a role the user does not hold.
- **Enforce exactly one primary in the database with a deferred constraint.**
  Deferred constraints need a transaction that always ends with the check
  satisfied, which would make every fixture and import responsible for the rule.
  The partial unique index plus a service that sets one is the smaller promise.
