# ADR 0066: A vehicle can change hands, and the change is audited

## Status

Accepted

## Context

The levy is per vehicle, and the owner is the person liable for it. A motorbike
is sold; the seller keeps paying for a vehicle he no longer rides, or the buyer
rides a vehicle that is registered to somebody else and cannot be reached when
there is a dispute.

Before this, the only way to change the liable person was to register the vehicle
again. That issues a **new sticker and a new short code**, orphans the old one on
the road (it still verifies, still prints the first owner), and splits the
vehicle's history in two.

## Decision

- **`PUT /v1/assets/:id/owner`** with `{ ownerId }` moves the vehicle to another
  owner. The asset keeps its id, short code, QR token, attributes, photos and
  scans; only `assets.owner_id` changes.
- **It needs `asset:create`, not `asset:manage`.** Ownership is a legal link and
  the same supervisory permission that registers a driver in the first place. A
  collector who may correct a plate number may not decide who owes the levy.
- **Both ends are checked.** The asset must exist in the tenant and so must the
  owner; an unknown owner is a `404`, never a dangling reference.
- **The audit row carries both sides**: `asset.reassign` with
  `before: { ownerId }` and `after: { ownerId, ownerName }`. Months later, "who
  was liable on that date" is answerable from the trail.
- **The dashboard never asks for an owner id.** `GET /v1/owners/by-phone/:phone`
  (`asset:read`) resolves the person from the number a clerk actually has, and
  the registry's owner panel offers two paths: find the buyer by phone, or create
  them and hand over in one step. The operator sees the name before confirming.
- **History stays with the vehicle, not the person.** Payments and scans were
  always recorded against the asset, so a sale does not rewrite them; the ledger
  remains the record of which days were paid.

## Consequences

- A vehicle sold to someone new is re-registered **without** a new sticker: the
  printed code on the bike keeps working, which is the point.
- The previous owner's phone stays verified on their person record; the new
  owner's verification is their own, and the panel shows it before a handover is
  confirmed.
- Nothing in the SMS/USSD channel changes: a driver pays by plate, short code or
  virtual account, all of which resolve the vehicle.
- A mis-sale is corrected by reassigning again, with a second audit row — not by
  editing history.
- The reassignment does not change the zone. A vehicle moved to an owner in
  another zone is still registered where it was; moving it is a separate
  correction, and the current `PATCH /v1/assets/:id` does not expose zone
  changes either.

## Alternatives considered

- **Register the vehicle again.** Rejected: a new sticker invalidates the one on
  the bike, and the vehicle's history splits in two, which is exactly what a
  registry is supposed to prevent.
- **Let `asset:manage` do it.** Rejected: collectors hold `asset:manage` for
  corrections, and moving liability is not a correction.
- **A free-text owner field on the asset.** Rejected: a name and phone typed into
  a text field cannot be verified, contacted or audited as a person record.
- **Reassign by editing the whole asset (attributes + owner in one PATCH).**
  Rejected: it mixes two permissions and two audit actions, and a client that
  only wanted to fix a plate would silently resend an owner.
