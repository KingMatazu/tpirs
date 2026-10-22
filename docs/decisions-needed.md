# Decisions needed

Open questions where guessing would be unsafe. Each entry lists options and a
recommendation. Until resolved, the safest default is used behind a config flag.

## D1: Hosting provider and data residency

**Status:** open (deferred in Phase 0).

The first states impose data-residency expectations that constrain where the
database and object storage may live. Until a provider is chosen, the deploy
step runs through the `noop` target.

- Options: managed Postgres + object storage in-region; self-hosted in a state
  data centre; sovereign cloud.
- Recommendation: managed Postgres in-region per tenant, one deployment per
  state (the default deployment model), chosen during Phase 11 onboarding.

## D2: Verification token format details

**Status:** partially resolved (Phase 2). Checksum is HMAC-SHA256 over the
opaque payload with a per-deployment key from `SecretsProvider`
(`qr-token-signing-key`); see ADR 0007. Still open: key rotation strategy and
short-code length rules.

- Recommendation: rotate by verifying against current and next keys during a
  overlap window; short-code length stays a tenant-config format string.

## D3: Payment instruction model per adapter

**Status:** open (Phase 4).

Adapters declare whether they support virtual accounts or references only. The
per-asset assignment strategy depends on the first gateway chosen.

- Recommendation: model both behind the `PaymentProvider` capability declaration;
  default to references until a virtual-account gateway is confirmed.

## D4: Tenant resolution at login

**Status:** open (Phase 1). Default chosen: explicit `tenantSlug` in the login body.

Session tokens are opaque and do not reveal their tenant, so login must resolve a
tenant before authentication. This is required for the multi-tenant deployment
mode (several states in one deployment).

- Options: require `tenantSlug` in the login body (current default); infer the
  tenant from the request hostname/subdomain; infer it when the deployment hosts
  exactly one tenant and require it otherwise.
- Recommendation: keep the explicit `tenantSlug` behind a config flag, and add
  hostname-based resolution for single-tenant deployments in Phase 9/11 when the
  dashboard and onboarding flows are built.

## D5: Rate limiting on the public verify endpoint

**Status:** open (deferred to Phase 5).

`GET /v1/verify/:token` is unauthenticated by design (ADR 0007) and has no rate
limit yet; token verification is HMAC-checked before any database access, so
abuse costs CPU then a bounded lookup, but field-scale abuse controls belong
with the driver channels phase.

- Options: fixed-window per-IP counters via the `Cache` port; token-bucket per
  network; upstream WAF rules.
- Recommendation: per-IP fixed window through the existing `Cache`/`LockService`
  ports when USSD/SMS rate limiting lands in Phase 5, sharing one limiter
  implementation.

## D6: Payment status in verify responses

**Status:** open (Phase 4).

The verify payload deliberately carries no payment field until obligations and
payments exist. When they do, the field must be additive and never render
"UNPAID" for a `pay_per_use` day with no obligation row (build brief section 6).

- Recommendation: add `paymentStatus` only with explicit values `PAID` /
  `NOT_IN_OFFLINE_LIST` semantics from the verification design; absence stays
  non-accusatory.

## D7: Multi-currency and FX

**Status:** resolved for v1 (deferred).
Multi-currency and FX are deferred. The schema is ready for it (each ledger entry stores its currency code, with a database constraint requiring it to match both accounts’ currency), but v1 uses one currency per tenant with no FX and no cross-currency postings.

- Recommendation: defer until a concrete requirement arises; the currency-matching constraint allows adding multi-currency later without a migration.

## D8: Surplus wallet credit refund policy

**Status:** open (business decision for the first tenant).

Surplus from allocations stays as wallet credit. It is auto-applied only when prepay is enabled, never beyond the configured horizon. The business policy for refunding surplus wallet credit is still to be decided.

- Recommendation: decide during first-tenant onboarding; track as a config flag/policy when needed.

## D9: Partial payments under pay_per_use

**Status:** resolved for v1.
Default is **no** partial payments under `pay_per_use`. The full fee is required for the current business day; a shortfall stays as wallet credit and the day stays unpaid.

- Recommendation: keep this as default; if needed later, make it configurable per tenant.

## D10: Fee rule shape in v1

**Status:** resolved for v1 (flat and per-asset-type, effective-dated only).

The `FeeEngine` port supports one rule shape in v1: a flat amount per asset
type, optionally a default rule for every asset type, with an effective date.
Zone-based pricing, tiered pricing, and per-customer pricing are not in the
v1 config model, so a tenant that needs them cannot express them today.

- Options: (a) flat/per-type effective-dated rules only; (b) add a zone
  dimension to the rule now; (c) add a tiered rule expression.
- Recommendation: (a) for v1. `selectFeeRule` already accepts an optional
  `zoneId` in its request, so (b) is an additive config change plus a new
  adapter, not a redesign. Tiered pricing should be a plugin behind the
  `FeeEngine` port (build brief section 5) rather than a core rule type, so
  that core works with zero plugins.

## D11: Partially paid periods in scheduled mode

**Status:** open.

Does a partially paid period count as paid in scheduled mode? The default is no.

- Recommendation: default to no; if needed, make it configurable per tenant.

## D12: Arrears age cap and lapse timing

**Status:** open.

Arrears age cap and the lapse timing for scheduled mode need to be defined.

- Recommendation: define defaults in config with clear semantics; allow per-tenant override.

## D13: Partial reversals

**Status:** deferred.

Partial reversals are deferred to a later phase. In v1, reversals are full-transaction only.

## D14: Wallet-first posting order and when an overpayment is recognised

**Status:** resolved for v1; the surplus _policy_ stays open in D8.

A payment is posted as `GATEWAY_CLEARING debit → ASSET_WALLET credit` and
only then allocated to periods, one `ASSET_WALLET debit → REVENUE_LEVY
credit` per period (ADR 0010). The consequence is that an overpayment is
recognised **per period, at the fee for that period**: a driver who pays three
days at once has paid one day, and the remaining two days are wallet credit
until their own period is created and paid.

- Options: (a) wallet first, per-period recognition (current); (b) recognise
  the whole payment as revenue on arrival and settle periods against it;
  (c) carry the overpayment as a per-asset credit that is applied to the next
  period automatically.
- Recommendation: (a) for v1, and (c) only for tenants whose model is
  `scheduled` and whose config allows it. (b) is rejected because it would
  recognise revenue for a day that has not been used, which is the
  "never falsely accusatory" rule running backwards — it would invent a debt
  as well as a credit.

## D15: Default allocation order

**Status:** resolved for v1; configurable per tenant.

`obligations.allocationOrder` accepts `oldest_first` (default) or
`today_first`. The order only matters for a `scheduled` tenant with more
outstanding periods than the payment can cover.

- Options: (a) `oldest_first`; (b) `today_first`; (c) per-tenant config
  with no default.
- Recommendation: (c) with a default of (a). Draining the oldest period first
  is the conventional arrears policy and is the safer default for a revenue
  authority; `today_first` lets a tenant keep a driver current at the cost of
  leaving an older debt open.

## D16: Prepay horizon

**Status:** open.

`obligations.prepaidAllowed` is off by default. When a tenant turns it on,
prepaid wallet credit may settle a period that is still in the future, and
the wallet may carry credit forward. Two questions are unanswered: how far
ahead a payment may prepay (a horizon in days or periods), and how long
surplus wallet credit is kept before it is written off or refunded (D8).

- Options: (a) a fixed horizon in tenant config, e.g. 30 days, and surplus
  kept indefinitely until used; (b) a horizon equal to the arrears window;
  (c) no horizon, surplus kept until spent.
- Recommendation: (a). A horizon in the tenant config keeps the rule
  explicit and auditable, and lets a state decide that a driver may not prepay
  more than one month. Keep surplus credit indefinitely in the meantime; the
  write-off question belongs with the refund policy in D8.
