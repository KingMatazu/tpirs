# ADR 0058: Registration is a supervisory act, and a zone supervisor registers in their zone

## Status

Accepted

## Context

Collectors registered vehicles in the field. That put the register in the hands of
the people taking cash: a collector could create an asset, and the API accepted it
because `POST /v1/assets` was guarded by `asset:manage`, which the collector role
holds for corrections. The collector app's registration screen has now been
removed, but hiding a button is not an access control — the endpoint was still
open to any collector token.

The pilot also needed a narrower rule than "anyone with the permission, anywhere":
a **zone supervisor** is responsible for one zone, and registering drivers for the
whole state is not their job.

## Decision

- **`asset:create` is a separate permission from `asset:manage`.** A collector
  keeps `asset:manage` (correct a plate, suspend a vehicle) but cannot create an
  asset or an owner. `POST /v1/assets` and `POST /v1/owners` require
  `asset:create`; the correction routes still require `asset:manage`.
- **A zone supervisor and a system admin hold `asset:create`.** The system admin
  also gains `asset:manage`: the dashboard's first job for a new deployment is
  building the register, and reading it while being unable to fix a typo is not a
  useful separation. Ledger and payment permissions stay out, as the brief
  requires.
- **A zone supervisor is assigned a zone.** `users.zone_id` (migration 0025) is
  required whenever the role set contains `zone_supervisor`, the same shape as the
  collector profile. The principal carries `zoneId` so a route can judge it
  without a second query.
- **`POST /v1/assets` fills or refuses the zone.** For a supervisor the asset's
  zone is their own: a missing `zoneId` is filled in, a different one is `403
cross_zone`, and an account whose zone was never recorded is `403
zone_required`. A missing answer fails closed rather than meaning "everywhere".
  A system admin is not a supervisor and keeps the whole tenant.
- **Roles are granted by migration, not only by the constant.** Roles are inserted
  once at provisioning, so migration 0024 adds the new permissions to existing
  tenant role rows. A deployment that migrates gets the rule without
  re-provisioning.

## Consequences

- The collector app is find → confirm → done → profile. No screen exists that the
  API would refuse.
- A supervisor without a zone is a broken account by design: the Accounts screen
  asks for the zone when the role is chosen, and an edit of such an account
  surfaces the same field rather than failing silently.
- **Reads stay tenant-wide.** A supervisor can only create in their zone, but
  `GET /v1/assets` and officer search still return the whole tenant. Scoping reads
  touches reports, reconciliation and the field app, so it is a separate decision
  (D61) rather than something this change slips in.
- The supervisor check keys on the seeded role key `zone_supervisor`, the same way
  the collector profile keys on `collector`. A custom role granted `asset:create`
  is not zone-scoped; if that becomes real, the scope needs to live on the grant,
  not on the role name.

## Alternatives considered

- **Remove `asset:manage` from the collector role entirely.** Simpler, but it also
  takes away corrections a collector makes in the street, which is the one thing
  they legitimately do to a record.
- **Enforce the zone in the asset service.** Rejected: the service takes a
  `tenantId`, not a caller, and putting principal-shaped logic there would make
  every non-HTTP caller pass a fake one. The route owns the rule, the service owns
  the write.
- **Store a list of zones per supervisor.** Rejected for now: one supervisor, one
  zone is the pilot's actual shape, and a join table can arrive when a second zone
  is real.
