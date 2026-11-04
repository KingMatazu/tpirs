# ADR 0062: Deleting an account leaves a tombstone, and a driver is not a role to grant

## Status

Accepted

## Context

Two gaps showed up once drivers moved to the Registry (ADR 0061):

1. **The Accounts screen still offered the `driver` role.** Choosing it created a
   staff account for a driver — a login nobody uses, because a driver pays with
   the short code on their sticker. The role existed because "driver
   self-service" was in the original brief, before the product decided drivers are
   owners plus assets.
2. **There was no way to remove an account.** The screen could disable one, which
   keeps it in the list forever, and a mistyped account could not be cleaned up.

Deleting is not a simple `DELETE` here. `audit_log.actor_user_id`,
`ledger_entries.created_by_user_id` and `collector_user_id`, cash intakes, scans,
disputes, reversals, settlements and reconciliation runs all reference
`users(id)`, and the audit trail is append-only by design. A hard delete would
either fail on a foreign key or, with cascades, erase the name behind money
movements — the one thing an auditor must always be able to resolve.

## Decision

- **Delete is a tombstone** (migration 0027, `users.deleted_at`). The account is
  disabled, its display name becomes "Deleted account", its email, phone, national
  ID, home address and zone are cleared, its password hash is replaced with a
  random one, its role grants are removed, its sessions are revoked, and its
  username becomes `deleted-<id prefix>` so the real name can be issued again.
  `GET /v1/users` filters tombstones out, so the account disappears from the
  screen, and the row remains as the subject of the history it took part in.
- **Two accounts cannot be deleted.** Your own (`assertNotSelf`, the same rule as
  every other edit here) and the last active `system_admin` — deleting that would
  leave a tenant nobody can administer.
- **The audit row records the deletion, not the person.** `user.delete` carries
  the username and roles before, and `{ deleted: true }` after; no email, phone,
  national ID or address, because the trail is append-only and those values could
  never be removed from it.
- **The `driver` role cannot be granted.** `POST /v1/users` refuses it with a
  `roleKeys` issue; `PATCH` refuses it only when the account does not already hold
  it, so a grant written before this rule can still be removed. The role stays in
  the catalogue for exactly that reason, and the Accounts picker hides it unless
  the account already has it.

## Consequences

- "Delete" does not reclaim the row, and cannot: history points at it. The UI says
  so in the confirmation ("What they did stays in the audit trail"), so an
  administrator is not surprised that a report still resolves the id.
- A deleted account's device bindings remain, inert: the username is unknown and
  the account is disabled, so nothing can authenticate as it. There is no device
  delete path yet; if one is added, deletion should use it.
- The username is reusable immediately. The tombstone is unique per tenant because
  it embeds the id prefix.
- `driver` role rows still exist for tenants provisioned before this change and
  will be created for new ones, because provisioning seeds the whole role
  catalogue. They grant nothing and cannot be assigned; removing the role concept
  entirely is a separate change to `SYSTEM_ROLES` and the seed.

## Alternatives considered

- **Hard delete when the account has no history.** Rejected: an account that has
  never signed in still has role grants and may be referenced by an audit entry,
  so the rule would be "sometimes it works", which is worse than one honest
  behaviour. It would also make the screen's promise depend on invisible history.
- **Disable only (status = disabled), as before.** Rejected as the answer to
  "delete": the row and the person's details stay in the list, which is exactly
  what the operator asked to remove.
- **Cascade the references (`on delete set null`).** Rejected: it would blank the
  actor on audit rows and the creator on ledger entries, turning a resolvable
  history into anonymous money.
- **Deleting the `driver` role from every tenant.** Rejected for now: it would
  strip a grant from accounts that hold it, and the role concept may return as a
  self-service driver login; refusing the grant is enough to stop new ones.
