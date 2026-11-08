# ADR 0070: Finance reconciles cash but never takes it

## Status

Accepted. Corrects the role grants introduced by [ADR 0031](0031-collector-cash-wallet.md)
and migration 0012.

## Context

The admin "Take cash" form lets a staff member record an intake on a collector's
behalf. The route required `cash:intake` and, for another collector,
`cash:freeze`. Migration 0012 granted `cash:intake` to `finance_admin` and
**not** to `zone_supervisor`.

The result was the opposite of the intent: finance — an office role that never
stands at a roadside — was the only staff role that could take cash on a
collector's behalf, while the supervisor who might need to backfill for a
collector whose phone failed could not. A finance administrator could settle a
driver's day out of any collector's float. Under the prepaid model (ADR 0069)
that is a direct debit on the collector's own money; under postpaid it
manufactures a debt the collector did not incur.

## Decision

- **A cash intake is a field act.** Only the collector may draw down their own
  float. A `zone_supervisor` may record on a collector's behalf, because they are
  on the ground and the collector's phone may be unusable.
- **Finance loses `cash:intake`.** It keeps `cash:read`, `cash:deposit:read`,
  `cash:deposit:match`, `cash:freeze` and `cash:unfreeze`: it reconciles what the
  field recorded and can stop a collector, but it cannot create the record.
- **The supervisor gains `cash:intake`.** Migration 0012 never granted it, which
  is why only finance could use the form.
- **The route checks the role, not `cash:freeze`.** `cash:freeze` is a
  supervision permission, not a licence to move another person's float; requiring
  the `zone_supervisor` role as well means a future mistaken grant of
  `cash:intake` to an office role still cannot take cash.
- **Existing tenants are corrected by migration 0029**, which removes the
  finance grant and adds the supervisor one; new tenants pick the sets up from
  `SYSTEM_ROLES`.

## Consequences

- The dashboard's "Take cash" form disappears for finance and appears for zone
  supervisors. A collector still records their own intake in the app.
- Finance can still correct a record it believes is wrong through the intake
  reversal path, which needs `payment:manage` and a second approver — the same
  dual-control rule the ledger uses for money leaving revenue.
- Zone scoping of a supervisor's writes is still open (D39): a supervisor can
  record for a collector in another zone. This ADR closes the finance hole; it
  does not claim the supervisor boundary is enforced.
- A deployment that gave `cash:intake` to a custom role keeps that grant; the
  route's role check still refuses a non-supervisor acting for someone else.

## Alternatives considered

- **Give the supervisor the permission and leave finance alone.** Rejected: the
  office role can still manufacture an intake and debit a collector.
- **Keep `cash:intake` on finance but require a reason and a second approver.**
  Rejected: finance has no legitimate reason to take cash, and a second finance
  user is not a field control.
- **Remove the admin "take cash" route entirely.** Rejected: a supervisor
  backfilling for a dead handset is a real operational need, and the collector
  must not be blocked by a flat battery.
- **Check `cash:freeze` as before but drop the finance grant.** Rejected as
  sufficient: a custom role with both permissions would pass, and the route
  should say what it means.
