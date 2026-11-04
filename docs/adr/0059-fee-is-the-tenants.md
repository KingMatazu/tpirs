# ADR 0059: The fee is the tenant's, and no intake screen may edit it

## Status

Accepted

## Context

Both intake screens let the person taking cash type the amount: the collector app
pre-filled it from the fee rule and the dashboard pre-filled it from its own
reading of the rule list. The API was stricter than either screen — a cash intake
must equal the tenant's fee exactly, or it is refused with `amount_mismatch`
(`collector-cash-service.ts`) — so the editable field could only ever produce a
rejection, with the driver standing at the bike.

The dashboard's pre-fill was also a second implementation: it read
`obligations.feeRules` directly and ignored `effectiveTo`, while the collector app
asked the fee engine. Two answers to one question is how a pilot ends up with a
screen that disagrees with the server.

## Decision

- **No intake screen has an amount field.** The collector app and the dashboard
  both state the fee for the asset type and business day, and the button sends
  exactly that. The dashboard resolves it with the same `FeeEngine` adapter the
  API checks against (`apps/admin/src/lib/tenantFee.ts`), so there is one answer.
- **A day with no fee rule is a blocked state, not a zero payment.** `decideCollect`
  returns `no_fee` before the float check, and the screen says the vehicle has no
  fee today rather than offering to collect nothing.
- **Only a system admin changes a fee.** A fee is a tenant config rule behind
  `tenant:configure`, which only `system_admin` holds. There is no in-app override,
  and the config screen is read-only today: a fee change is a config update
  (`PUT /v1/tenants/current/config`), audited.

## Consequences

- `prefillAmountMinor` is deleted from the dashboard; `tenantFee.ts` replaces it.
  The admin app now depends on `@tpirs/fee-engine-config` (a workspace package, no
  new external dependency).
- The API's `amount_mismatch` error stays: it is the defence against a config
  change between the screen loading and the cash being recorded, and against a
  client that is not one of ours.
- A fee change mid-shift can still make a stale screen wrong. The server refuses
  it and the collector sees "The amount does not match today's fee", which is the
  honest answer; the phone re-resolves the fee on the next confirm.
- Editing fees from the dashboard is not in this change. If it is wanted, it is a
  config-editor screen with an audit entry, not a field on the cash form.

## Alternatives considered

- **Keep the field editable and let the server refuse.** Rejected: it invites the
  one failure the collector cannot fix at the roadside, and the refusal is
  indistinguishable from a broken phone.
- **Add a system-admin override on the cash screen.** Rejected: a per-payment
  override is a pricing decision hidden in an operational screen, and it would
  have to be audited and reconciled as its own thing.
