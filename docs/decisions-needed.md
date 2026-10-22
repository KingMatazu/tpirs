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

**Status:** resolved by D17 (Phase 4).

Adapters declared only whether they support virtual accounts or references, which
is not enough: the two are different _attribution_ mechanisms with different
failure modes. D17 replaces the two booleans with a declared list of attribution
kinds, and the intent reports which kind it used.

- Recommendation carried forward: keep `supportsVirtualAccounts` as a derived
  convenience and make `attributionKinds` the source of truth, so an adapter
  cannot claim a capability it does not implement.

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

**Status:** resolved for v1; mechanics settled in D19.
Default is **no** partial payments under `pay_per_use`. The full fee is required for the current business day; a shortfall stays as wallet credit and the day stays unpaid.

- Recommendation: keep this as default; if needed later, make it configurable per tenant.
- D19 adds the part this entry left open: credit is never consumed
  automatically. It is spent only when the driver declares a working day, and
  a tenant may instead route shortfalls to suspense
  (`payments.underpaymentPolicy`).

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
- D19 clarifies the timing: wallet credit is never consumed by the passage of
  time or by a later payment making the balance whole. Under `pay_per_use`,
  credit settles a day only when the driver declares that day, either by
  paying for it or by choosing "pay today from balance".

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

## D17: Attributing a payment to an asset

**Status:** resolved (Phase 4).

Under `pay_per_use` there is roughly one payment per working day, so the payment
must land on the right asset with no human in the loop. Narration matching is
not good enough to be the default: drivers type transfer narrations on
feature-phone bank USSD menus, banks truncate or drop the field, and a single
typo sends a working driver's money to suspense while they stand at the
roadside.

- Options: (a) intent reference issued at declaration time; (b) one dedicated
  virtual account per asset; (c) a shared account plus a narration reference.
- Decision: **(a) primary, (b) optional, (c) last resort**, in this order, with
  the adapter declaring which kinds it supports.
  - **Intent reference.** The driver dials USSD and enters the sticker's short
    code. The system creates a `PaymentIntent` for that asset at
    `fee − wallet balance` and the gateway returns a reference (a one-time
    transfer account where the gateway supports it). The webhook carries that
    reference, which maps to the intent and therefore to the asset. No narration
    is involved. If the wallet already covers the fee, no intent is issued —
    the only sensible action is "pay from balance" (D19).
  - **Virtual account.** A per-asset DVA, gated by
    `capabilities().attributionKinds.includes("virtual_account")`, for tenants
    that can afford one account per asset.
  - **Narration reference.** Shared account plus a short alphanumeric reference
    with a check character, matched tolerantly (case and whitespace ignored).
    This exists so a gateway with no other mechanism can still be supported; it
    is never the default.
- Port change: `capabilities()` returns `attributionKinds`, and
  `createPaymentIntent` returns the `attribution` it used (`kind` plus the
  instruction). An adapter that cannot issue an intent reference must say so
  rather than silently fall back to narration.
- Suspense still applies: a payment whose reference matches no intent and no
  instruction, or whose amount and currency do not fit, goes to suspense
  (D19). Attribution moves the failure from "usually wrong" to "rarely
  unattributable".
- Sandbox checks in "Phase 4 sandbox checks" below must be answered before the
  first real adapter is declared production-ready.

## D18: Which tenant owns a webhook

**Status:** resolved (Phase 4).

The webhook route has no staff session, but every money table is scoped by
`tenant_id` through row-level security. Worse, the tenant must be known
_before_ the signature can be checked, because each tenant has its own secret
key; looking the tenant up from the payload would mean trusting unverified
input to choose which secret to verify against.

- Options: (a) resolve the tenant from a per-tenant endpoint token in the path;
  (b) resolve from the gateway account id in the payload; (c) require one
  deployment per tenant.
- Decision: **(a)**, with (c) as the deployment default.
  - Route: `POST /webhooks/:provider/:endpointToken`. The token is an
    unguessable value that maps to exactly one tenant and one secret reference.
  - Storage: a `webhook_endpoints` table with a SHA-256 hash of the token, not
    the token itself, so a database read does not yield working webhook URLs.
    The table is outside row-level security (it cannot be tenant-scoped before
    the tenant is known) and is reachable only through a narrow
    `SECURITY DEFINER` function that returns tenant id, provider, and secret
    reference for one hash. The application role gets `EXECUTE` on the function
    and no `SELECT` on the table.
  - Order of operations: look up the token, verify the signature, and only then
    set `app.tenant_id` for the transaction that stores and processes the
    event. Nothing that depends on tenant data runs before verification.
  - Dedicated deployments that cannot configure a custom webhook path fall back
    to a configured default tenant; the token path remains the supported one.
  - Rejected calls are rate limited. They are audited only when the tenant is
    known (valid token, bad signature, actor `system`); an unknown token has no
    tenant to attribute an audit row to, so it is logged as telemetry instead.
  - The token is redacted in request logs, traces, and any proxy access log,
    because a token in a URL is a secret in a URL.

## D19: Underpayment, wallet credit, and when credit is spent

**Status:** resolved (Phase 4).

A shortfall must not force finance to intervene while the driver is at the
roadside, and it must not silently become revenue for a day the driver may not
have worked. Suspense on every short payment gets the first wrong; automatic
deduction gets the second wrong.

- Decision: **wallet credit, declaration-gated.**
  - A payment below the fee credits the asset wallet and leaves the day unpaid.
    Nothing is allocated. The day is either paid in full or not paid at all;
    there are no partially paid periods under `pay_per_use`.
  - Credit is never consumed by the passage of time, and never consumed because
    a later unrelated payment happens to make the balance whole. It is spent
    only when the driver declares that day, either by paying for it (the
    payment is the declaration) or by choosing "pay today from balance".
  - If the balance covers the fee at declaration time, exactly one day is
    applied. If it does not, nothing is applied; the driver receives an SMS
    stating the exact shortfall and can pay the difference, for which the intent
    amount is `fee − balance`.
  - `payments.underpaymentPolicy`: `wallet` (default) or `suspense`, for states
    that want finance review of every short payment. Currency mismatches and
    unattributable payments always go to suspense regardless of this setting.
  - States on a payment row: `applied` (day settled), `credited` (wallet
    credited, no day settled), `suspense`, `rejected`. A `credited` payment has
    no business date until a declaration settles a period.
  - Verification is unchanged in meaning: an asset with credit but no
    declaration shows UNPAID because no day was declared, and that carries no
    debt meaning.
- Rejected: partial allocation (a period cannot be half paid without inventing a
  debt), and silence-as-consent deduction (it would spend money the driver did
  not declare).

## D20: Receipts and their delivery guarantees

**Status:** resolved (Phase 4).

An SMS that is sent twice costs money and alarms the driver; an SMS lost when the
process dies leaves the driver without proof of payment. Neither is acceptable,
and neither can be fixed by retrying from the webhook handler.

- Decision: **transactional outbox per payment.**
  - The `sms_log` row is inserted in the same database transaction that moves
    the payment to `applied`, with the body already rendered from the tenant
    template and the exact amounts. Delivery happens afterwards, from the
    worker, so the money transaction never waits on the SMS provider.
  - `sms_log` has a unique constraint on `(payment_id, kind)`, which makes a
    replayed webhook, a retried job, and a duplicate outbox row all no-ops.
  - Kinds: `receipt` (payment applied, including a payment applied when finance
    resolves a suspense item) and `underpayment_notice` (wallet credited with a
    shortfall). They are separate rows so one can succeed while the other is
    retried.
  - No SMS is sent for a duplicate webhook, a suspense item, or a rejected
    payment until it is resolved.
  - Template text and language come from tenant config and i18n, never from
    code. The receipt is sent once per `(payment, kind)`, not once per attempt.

## D21: Bank-statement import

**Status:** resolved; deferred to Phase 8 (reconciliation).

A bank-statement CSV has no signature, no provider event id, and no intent
lifecycle, so it cannot honestly implement `PaymentProvider`: every method would
have to lie about a capability the file does not have. It is also a
reconciliation input, not a payment intake channel — the money already moved
without the platform.

- Decision: a separate `SettlementImport` port in Phase 8, feeding
  reconciliation only. Idempotency is a file hash plus a row hash, so
  re-uploading the same statement and overlapping date ranges cannot double
  count.
- `AGENTS.md` previously listed bank-statement CSV as a `PaymentProvider`
  alternative; that line is corrected.

## Phase 4 sandbox checks (first real adapter)

These are questions for the gateway sandbox and dashboard, not assumptions to
code against. They are answered before the adapter is called production-ready.

1. **One-time transfer account.** Does the intent/charge path return a
   temporary account, and after how long does it expire? What happens to a
   payment made after expiry?
2. **Reference round-trip.** Which webhook field carries the reference back, is
   it stable across retries, and is it unique per intent or reusable?
3. **Dedicated virtual accounts.** Cost per account, whether creation requires a
   verified customer, per-tenant limits, and whether the account number can be
   reissued.
4. **Signature and retries.** Which header and encoding the signature uses, the
   retry schedule, and whether a 401 stops retries or continues them.
5. **Partial transfers.** Whether a transfer below the intent amount can arrive,
   and how the payload reports it (amount only, or a partial flag).
6. **Narration reliability.** Field length and whether the bank layer truncates
   or drops narration — this decides whether the narration fallback is
   supportable at all.
7. **Fees.** Who bears gateway fees, and whether the amount credited to the
   state account is net or gross; a net settlement changes the reconciliation
   tolerance, not the ledger.
