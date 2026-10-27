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

**Status:** resolved (Phase 5, ADR 0024).

`GET /v1/verify/:token` is unauthenticated by design (ADR 0007). Phase 5 adds a
shared fixed-window limiter over the `Cache`/`Clock` ports, the same one used by
USSD and inbound SMS.

- Decision: **60 requests per source IP per minute**, expressed as a platform
  constant, not tenant config. Tenant identity is unknown until after the asset
  lookup, and by then the work the limit protects has already happened. A
  tenant-configured limit would also let one tenant widen a platform-wide abuse
  control.
- Exceeding the limit returns `429` with the standard error envelope and a
  `Retry-After` header.
- If the verify endpoint ever becomes tenant-scoped before lookup, the limit can
  move behind a configurable key without changing the limiter.

## D6: Payment status in verify responses

**Status:** resolved (Phase 6, ADR 0028).

The verify payload carries `paymentStatus` with the values `paid`,
`no_payment_recorded` and `unknown`. A `pay_per_use` day with no obligation row
is `no_payment_recorded`, never a debt; the string `unpaid` never appears on
the wire. `unknown` is reserved for a tenant whose ledger or config cannot be
read.

- Decision: business date computed server-side from the tenant timezone; the
  response carries it so an offline client can tell when its cache is stale.
- Decision: `not_in_offline_list` is a field-app-only label, never a server
  payment status.
- Decision: the paid set is the set of assets with a `paid`/`waived` period for
  the current business date; the delta feed pages by `(updated_at, id)` and a
  reversal removes membership.

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

## D22: Channel webhook tenancy and endpoint tokens

**Status:** resolved (Phase 5, ADR 0022).

Driver channels (USSD/SMS) need tenant isolation without letting callbacks
reveal which tenants/adapters exist.

- Decision: **per-tenant endpoint token in the URL** (`POST /webhooks/{provider}/{endpointToken}`), hashed and resolved via a `SECURITY DEFINER` function (`resolve_webhook_endpoint`) the same way payment webhooks behave (ADR 0017). The tenant and enabled channels are unknown until lookup.
- An unknown token, a revoked token, and a channel/adapter the tenant has not enabled all return 404 identically (anti-enumeration).
- The adapter key in the URL must equal the tenant's configured binding for that port; otherwise 404.
- Channel callbacks use `application/x-www-form-urlencoded` (and JSON) and pass raw bodies/headers to adapters for provider-specific parsing.

## D23: USSD session state model

**Status:** resolved (Phase 5, ADR 0023).

- Decision: **stateless replay of cumulative `text`.** The pure domain engine (`advanceUssdSession`) reconstructs navigation from the menu graph and cumulative input. No server-side session store is required; retries are safe and the same engine runs in the UI simulator.
- Menu graph and messages come from tenant config (`channels.menus`, `channels.messages`), not code.

## D24: Inbound SMS callback parsing and polling

**Status:** resolved (Phase 5, ADR 0021).

- Decision: **primary webhook parsing, polling fallback.** Adapters may support webhook callbacks (`parseInboundCallback`) and/or polling for inbound messages. The factory/wiring supports both; real adapters may return empty polling results when push-only.

## D25: Driver message catalogs and i18n keys

**Status:** resolved (Phase 5).

- Decision: **message catalogs live in `channels.messages` keyed by language and message key** (`packages/config/src/channel-contract.ts` defines canonical keys: operational messages, asset input key, and per-action keys). Templates may use placeholders (e.g., `{amount}`, `{assetRef}`, `{date}`, `{receiptNo}`, `{code}`) validated at load time. All driver-facing copy comes from config/i18n, never hardcoded literals.

## D26: Browser session storage for the dashboard

**Status:** resolved (UI track, ahead of Phase 9).

The admin dashboard (`apps/admin`) is a React + Vite SPA talking to
`packages/api-client`, with no server rendering. The browser must hold a staff
session without exposing it to any script running in the page, and a page
reload must not force a manual re-login.

- Options: (a) access and refresh tokens in `localStorage`; (b) all auth in an
  httpOnly cookie on every endpoint; (c) short-lived bearer in memory plus a
  refresh token in a narrowly scoped httpOnly cookie.
- Decision: **(c)**.
  - The access token lives in memory only (a zustand store), is never
    persisted, and dies on tab close and on reload.
  - The refresh token is an `httpOnly`, `Secure`, `SameSite=strict` cookie
    scoped to `/v1/auth/refresh`; the browser never exposes it to page script.
  - The server rotates the refresh token on every use and keeps revocation
    keyed to the staff session, so a stolen previous refresh token is
    single-use.
  - After a reload, the first API call that receives a 401 triggers one
    transparent refresh-and-retry before failing; the user experiences a
    silent re-login. A missing TOTP-verified session still fails closed.
- Rejected: (a) because any XSS in a dependency can read and replay the tokens
  at leisure; (b) because a cookie valid on every endpoint widens the CSRF
  surface and duplicates the API's own bearer checking. This record is
  dashboard-only by design: the field PWA and its offline constraints are
  deferred entirely (D29).

## D27: UI form library and component base

**Status:** resolved (UI track).

- Components: **shadcn-style copy-in layer — Tailwind for styling, Radix UI
  primitives for behavior**, themed exclusively through CSS custom properties
  emitted by `packages/ui-tokens`. shadcn/ui is Radix + Tailwind, not an
  alternative to them: Tailwind owns visuals; Radix owns focus trapping,
  keyboard navigation, and ARIA for dialogs, dropdowns, popovers, and toasts.
  Stripping Radix would mean hand-rolling buggy accessibility at the exact
  places the dashboard leans on it (dual-approval dialogs, roles-aware
  navigation, error toasts).
- Forms: **react-hook-form + zod.** The UI submits small, money-sensitive
  forms (resolve a suspense item, correct an asset); zod schemas are derived
  from the generated OpenAPI types, so client validation cannot drift from
  the contract.
- Bundled picks recorded here because they arrive in the same change:
  **TanStack Query** for server state (cursor pages, retries, mutations),
  **zustand** for session and navigation state, **lucide** for icons, and
  `Intl.NumberFormat`/`Intl.DateTimeFormat` fed from tenant config for
  currency and date rendering — no date library for display, and business-day
  math stays server-side where it belongs.
- Rejected: MUI and Ant Design (they ship their own design system — a second
  source of visual truth that fights `ui-tokens` and hardcodes colors);
  Formik (in maintenance mode); writing forms with no library (pushes
  money-affecting submissions toward hand-rolled state, where duplicate
  submissions happen).
- UI end-to-end tests use **Playwright**; alternative considered: Cypress.
  Recorded here per the "record every dependency" rule.

## D28: OpenAPI document and api-client generation

**Status:** resolved (UI track).

The API routes are hand-written Fastify today (AGENTS.md: API-first arrives
incrementally). The dashboard cannot exist without a typed client, and a
hand-maintained OpenAPI YAML would drift from the code.

- Decision: **code-first.** Route handlers add the JSON Schemas Fastify wants
  anyway; `@fastify/swagger` emits the OpenAPI 3 document from them, so the
  running server _is_ the contract and cannot diverge from the doc.
  - `packages/api-client` is generated with `openapi-typescript` (types) and
    `openapi-fetch` (a ~1 KB type-safe fetch wrapper). The package re-exports
    the generated client plus the shared plumbing: idempotency-key attachment
    on money-affecting POSTs, request-ID extraction, and the standard
    error-envelope parser.
- Rejected: contract-first, hand-maintained YAML feeding both sides (reads
  nicely in review but drifts from continuously evolving hand-written
  routes); Orval (generates opinionated TanStack Query hooks — another
  codegen layer to debug); tRPC (superb types but abandons REST/OpenAPI,
  which the brief names as the source of truth); a hand-rolled client
  (drifts — the very problem this decision exists to prevent).

## D29: Field PWA offline store

**Status:** resolved (Phase 6, ADR 0029).

The officer field app reopens in Phase 6 as `apps/field`. The store uses
IndexedDB via the `idb` wrapper with five stores: a paid-set cache replayed
from the delta sync feed (status computed at render time by _presence in the
set_, so the store cannot hold or derive UNPAID); a bounded asset/photo cache;
an append-only outbox of idempotent commands keyed by client-generated UUIDs
and deduplicated server-side (no last-write-wins merging — offline scans and
disputes are facts, not state); sync state holding the business date and
monotonic cursor; and a display-only `fieldSession` record for the shift grace
window.

- Decision: online login at least once per shift, then a configurable offline
  grace window; queued work is re-authorised and attributed server-side at
  sync time.
- Decision: the client parses the opaque QR payload for offline membership but
  never verifies the HMAC and never derives a negative status.

## D30: Offline sticker lookup key

**Status:** resolved (Phase 6, ADRs 0028/0029).

An offline phone cannot verify the QR checksum: the signing key stays on the
server. The field app therefore splits the token, uses the opaque payload as a
lookup key in the cached paid set, and renders only `paid` or
`not_in_offline_list`. A malformed token produces "scan again", not a status.

- Decision: the paid-set feed carries `qrPayload` and `shortCode`, so both a
  camera scan and a typed short code can be checked offline.
- Decision: offline absence is never a claim of non-payment.

## D31: Field session and offline grace

**Status:** resolved (Phase 6, ADR 0029).

Officers need the app after the screen locks or the browser is reopened with no
network. The field app requires an online login at least once per shift, then
allows a configurable offline grace window (default 12 hours). The access token
stays in memory (D26); the httpOnly refresh cookie handles re-auth when the
network returns.

- Decision: the cached principal is display-only; every queued scan or dispute
  is authorised and attributed from the fresh server session at sync time.
- Decision: if the refresh cookie has expired, queued work waits until the
  officer logs in again.
- Decimal coordinates are optional, best-effort and never block a result.

## D32: Paid-set scope at scale

**Status:** open (Phase 6, with a recorded trigger).

The first feed is tenant-wide for the current business date, paginated and
capped. A large city may produce a paid set too big for a low-end phone.

- Options: keep tenant-wide; scope by officer-assigned zones; scope by a
  bounding box around the device.
- Recommendation: ship tenant-wide for the pilot and measure the set size. Add
  zone scoping when officers have zone assignments (a Phase 7/8 prerequisite)
  or when the measured set exceeds the agreed phone budget.

## D33: Dispute evidence transport

**Status:** resolved (Phase 6, ADR 0030).

At most one optional photo per dispute, downscaled on the device and posted as
base64 JSON in the create request, stored through `ObjectStorage`. The route
gets a larger body limit; the client resizes before queueing so an offline
outbox item stays small.

- Alternatives deferred: multipart uploads, multiple photos, resumable uploads.

## D34: Scan and dispute retention

**Status:** open (Phase 8).

`scans`, `disputes` and `dispute_evidence` follow `compliance.retentionDays`.
No purge job exists in Phase 6; rows are append-only except the dispute
resolution fields reserved for Phase 8.

- Recommendation: implement a scheduled purge in Phase 8 alongside the
  reconciliation jobs, with a dry-run count and an audit entry per run.

## D35: Over-deposit and unmatched collector cash

**Status:** resolved (Phase 7, ADR 0032).

A collector deposits more than their open intakes cover, or deposits with a
reference nobody recognises. Options: keep the surplus in suspense; credit the
collector's next obligation automatically; refund it through the payment
provider; reject the deposit.

- Decision: **keep it in suspense.** The deposit is recorded with
  `status = 'suspense'` and no wallet, vehicle or day is credited. Finance
  matches it to a cash intake once the asset works that day and a payment is
  allowed, or it stays visible in the exceptions queue.
- Decision: the surplus is never auto-applied to the next day. Auto-crediting
  would turn a bank mistake into a free day for a vehicle that may never have
  worked, and it would hide the discrepancy from finance.
- Rejected: refund through the provider (the platform is not the merchant of
  record for a bank transfer, and refunds are Phase 8 work); rejecting the
  deposit (the money has already arrived and must be recorded).

## D36: Cash intake for a day that is already paid

**Status:** resolved (Phase 7).

Under `pay_per_use` a vehicle can only be paid once per business day. A
collector taking cash for a day that already has a recorded payment would
either take the driver's money for nothing or park it as wallet credit.

- Decision: **reject the intake** with a typed `already_paid` error and let the
  collector verify first (`GET /v1/verify/:token` or the admin lookup). No
  money changes hands and no ledger entry is posted, so the counter
  conversation stays honest: "this vehicle is already paid today".
- Decision: wallet credit is not used here. Underpayment-to-wallet-credit (D19)
  covers money that arrived through a gateway and could not be refunded
  instantly; cash at the counter can simply not be taken.
- Rejected: accepting it and crediting the wallet (creates counter cash that
  cannot be explained to the driver and complicates the day's reconciliation);
  accepting and overwriting the period (violates append-only money and the
  paid-set contract).

## D37: Who may freeze and unfreeze a collector wallet

**Status:** resolved (Phase 7, ADR 0033), with a recorded trigger.

A collector must never be able to unblock themselves, but the supervisor
standing in the zone is the person who discovers the problem.

- Decision: **freeze** is allowed to `zone_supervisor` and `finance_admin`;
  **unfreeze** is `finance_admin` only for Phase 7.
- Decision: both require a reason and are audited; the automatic freeze on a
  missed deadline records the sweeper as the actor.
- Trigger for change: when an explicit user-to-zone assignment exists (D39), a
  supervisor with `cash:unfreeze` may unfreeze collectors in their own zone.
  The service already takes the caller's principal, so that is a policy change,
  not a signature change.
- Rejected: letting supervisors unfreeze now (they would unfreeze by asset
  zone, so any supervisor could unfreeze a collector who worked one asset in
  their zone).

## D38: Cash receipt and freeze-notice copy

**Status:** resolved (Phase 7).

A cash receipt is driver-facing copy, so it cannot live in code.

- Decision: a tenant-configured cash receipt template (sibling to
  `channels.smsReceiptTemplate`) with the placeholders `{amount}`,
  `{assetRef}`, `{date}` and `{receiptNo}`, validated at load time so an
  unknown placeholder is a startup failure rather than a literal brace in an
  SMS.
- Decision: the freeze and overdue notices go through the channel message
  catalogue under new keys, so every enabled language must supply them once a
  tenant has a `messages` catalogue.
- Rejected: reusing `smsReceiptTemplate` for cash (the wording must not imply a
  gateway payment, and a receipt that says "payment received" for cash is a
  reconciliation argument waiting to happen).

## D39: Collector-to-zone scoping for supervisors

**Status:** open (Phase 7, with a recorded trigger).

Supervisor views and freeze authority are scoped by the **asset's** `zone_id`
snapshotted on the intake, because no user-to-zone table exists. A collector who
works across zones therefore appears in more than one supervisor's view.

- Options: scope by asset zone (current); add a user-to-zone assignment table
  and scope by the collector's assigned zone; scope by the zone the cash was
  taken in, recorded explicitly at intake.
- Recommendation: keep asset-zone scoping for the pilot and record the
  limitation openly. Add a user-to-zone assignment when identity work next
  reopens (it also unblocks D37's supervisor unfreeze and D32's zone-scoped
  paid-set feed), then scope both views and freeze authority by assignment.
- Rejected for now: a collector-to-zone column on `collector_wallets` — it
  would be a second source of truth for zone membership that drifts from
  whatever identity later introduces.
