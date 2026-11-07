# Collector wallet funding: a Virtual Terminal per collector, prepaid float

Status: implementation in progress (Phase 12). ADR [0069](adr/0069-collector-virtual-terminal-funding.md).
Supersedes the dedicated-account (DVA) funding design in ADR
[0032](adr/0032-cash-deposit-attribution.md) for tenants on the prepaid model.

## Why this exists

A collector takes cash from drivers. The platform has to know how much of the
state's cash that collector is holding, and the collector has to be able to put
money back into the platform without finance matching transfers by hand.

The old design gave each collector a dedicated virtual account through Paystack's
DVA API and matched deposits against open intakes (postpaid). The DVA API needs
eligibility and BVN data the pilot does not have, and a postpaid collector cannot
"fund a wallet" — a deposit with no open intake is held in suspense, which is the
opposite of what a pre-funded float means.

This plan replaces that rail with **one Paystack Virtual Terminal per collector**
and makes the wallet **prepaid**: the collector tops up first, and each cash
intake draws the balance down.

## Decisions locked

| Decision        | Value                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Funding rail    | Paystack Virtual Terminal, one per collector, NUBAN where Paystack issues one               |
| Wallet model    | `prepaid` for this tenant; `postpaid` remains the default for every other tenant            |
| Attribution     | `metadata.virtual_terminal.code` (fallback `source.identifier`) resolved to the instruction |
| Top-up amount   | any amount the collector transfers; no charge to create, no expiry                          |
| Maximum balance | configurable, default ₦50,000 (`5_000_000` minor)                                           |
| Intake guard    | configurable `hard` (default, limit 0) or `grace` up to `graceMinor`                        |
| Gateway fee     | borne by the State; the collector is credited gross                                         |
| Settlement      | credited to `GATEWAY_CLEARING` on arrival, fee expensed at settlement                       |
| Fallback rail   | Pay with Transfer with a preset ladder, added later behind the same config switch           |

Paystack is currently in **Test Mode**. The adapter is built and tested against
injected HTTP; the same code runs live once `SECRET_PAYMENTS_PAYSTACK_SECRET_KEY`
holds a live key.

## Gate 0 — checks before the pilot goes live

These are deployment checks, not code. They must be answered on the pilot's
Paystack business before collectors fund real money.

1. **Virtual Terminal is enabled** on the business. In Test Mode it is available;
   a live business may need the product switched on.
2. **Terminal limit per integration.** Ask Paystack support. One terminal per
   collector is the model; a hard cap below the collector count needs the PwT
   fallback.
3. **Dedicated NUBAN in test mode.** `POST /virtual_terminal` returns
   `paymentMethods: []` in some markets/domains and a `dedicated_nuban` entry in
   Nigeria live. The app must work with either: a terminal without a NUBAN shows
   the terminal page URL instead.
4. **Teller deposit.** Confirm a bank branch will accept a cash deposit into the
   terminal's dedicated NUBAN. If not, collectors fund from their bank app only.
5. **Fee line.** Confirm the pilot's tariff: terminal transfers are published at
   1% capped ₦300, while a checkout card payment is 1.5% + ₦100 capped ₦2,000.
   The 1% case is the one this design relies on.
6. **Settlement statement shape.** Pay a terminal in test mode and inspect the
   settlement row: it must carry the terminal code or the transfer reference so
   reconciliation can match it.

## Configuration plan

`cashRules` gains four optional fields. Omitting them keeps today's behaviour for
every existing tenant, so no stored config or fixture changes shape.

```yaml
cashRules:
  enabled: true
  floatCeilingMinor: 5000000 # postpaid: undeposited cash ceiling
  depositDeadlineHours: 24 # postpaid only
  freezeOnShortfall: true # postpaid only
  model: prepaid # default: postpaid
  maxBalanceMinor: 5000000 # prepaid only; default 5_000_000 (₦50,000)
  intakeGuard: hard # default: hard; "grace" allows a negative
  graceMinor: 0 # default 0; only read when intakeGuard is "grace"
  funding: virtual_terminal # only value today; "pay_with_transfer" later
```

Rules enforced by the validator:

- `model` is `postpaid` or `prepaid`; anything else is a config error.
- `maxBalanceMinor` and `graceMinor` are non-negative integers.
- `intakeGuard: hard` forces `graceMinor` to `0`; a positive grace with a hard
  guard is rejected rather than silently ignored.
- `funding` is `virtual_terminal` today; `pay_with_transfer` is added when that
  adapter lands.
- Under `prepaid`, `floatCeilingMinor`, `depositDeadlineHours` and
  `freezeOnShortfall` stay in the schema for compatibility but are not used by
  intake; the maximum balance and the guard replace them.

Defaults live in `packages/config/src/defaults.ts`, and accessors in
`packages/config/src/cash-rules.ts` (`cashModelOf`, `maxBalanceMinorOf`,
`intakeLimitMinorOf`) keep `undefined` meaning "the documented default", so code
never branches on a missing field.

## Money rules

The ledger keeps its existing shape: `COLLECTOR_CASH` is the state's asset, so a
**positive** derived balance means cash in the collector's hands and a
**negative** balance means prepaid credit the platform holds for them.

| Event                      | Posting                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| Top-up (terminal transfer) | `Dr GATEWAY_CLEARING / Cr COLLECTOR_CASH` (gross)                                |
| Cash intake                | `Dr COLLECTOR_CASH / Cr ASSET_WALLET` (unchanged)                                |
| Settlement                 | `Dr SETTLEMENT_BANK (net) + Dr GATEWAY_FEES (fee) / Cr GATEWAY_CLEARING (gross)` |

- **Credit gross.** The collector transferred ₦50,000, so ₦50,000 of float is
  what they get; the gateway fee is the State's cost and is expensed when the
  settlement line is posted.
- **No suspense under prepaid.** A top-up always credits the wallet; there is no
  open intake it has to justify.
- **Over the maximum balance** is not refused (the money has already arrived):
  the wallet is credited, a `cash.topup.over_cap` audit row and a telemetry
  counter are written, and the dashboard flags the collector. Future intake is
  unaffected.
- **Refunds** are allowed only while the derived balance covers them; otherwise
  the refund is refused and finance opens a receivable. Documented in the runbook.

### Intake guard

`limit = model === "prepaid" ? graceMinor : floatCeilingMinor`, and an intake is
allowed when `balance + amount <= limit`.

- **Prepaid, hard (default):** `limit = 0`. A collector with no top-up cannot take
  cash; a collector holding ₦50,000 of credit can take up to ₦50,000.
- **Prepaid, grace:** `limit = graceMinor`, e.g. ₦2,000. The balance may go
  ₦2,000 positive, which covers one intake queued while offline.
- **Postpaid:** unchanged (`balance + amount <= floatCeilingMinor`).

The collector app uses the same number: `availableMinor = max(0, limit − balance)`.
The server is authoritative; the phone only shows the decision.

## Data model (migration 0028)

Reuse `collector_deposit_instructions`; no new table.

- widen `kind` to `('virtual_account', 'narration', 'virtual_terminal')`;
- add `details jsonb not null default '{}'` holding
  `{ accountNumber?, accountName?, bank?, pageUrl?, currency? }`;
- no new status: `active` / `revoked` already exist, and `revoked_at` records a
  rotation.

`cash_deposits` is untouched. Its identity is `webhook_event_id` (migration 0013),
so a collector can deposit any number of times to the same destination.
`cash_deposits.provider_reference` stores the attribution key (`VT_…`) when the
adapter supplies one, and the provider's transaction reference otherwise.

## Port and adapter

`PaymentProvider` gains:

```ts
export interface DepositAttributionRequest {
  readonly collectorUserId: string;
  readonly idempotencyKey: string;
  readonly name?: string;      // terminal name shown to the payer
  readonly phone?: string;     // WhatsApp destination
  readonly currency?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface DepositAttribution {
  readonly kind: "virtual_account" | "narration" | "virtual_terminal";
  readonly value: string;            // VT_… for a terminal
  readonly accountNumber?: string;
  readonly accountName?: string;
  readonly bank?: string;
  readonly pageUrl?: string;
  readonly currency?: string;
}

// NormalizedPaymentEvent
readonly attributionKey?: string;    // metadata.virtual_terminal.code
```

`createDepositAttribution` stays the name (it creates the destination);
`deactivateDepositAttribution?(reference)` is added so removing a collector
deactivates their terminal.

The Paystack adapter becomes a real HTTP client: secret key and webhook secret
from the `SecretsProvider` (injected at the composition root), `fetch` injectable
for tests, 15-second timeout, `PortError` mapping, and recorded fixtures. Methods:
`POST /transaction/initialize`, `POST /virtual_terminal`,
`PUT /virtual_terminal/:code/deactivate`, webhook normalisation with
`metadata.virtual_terminal.code`. `fetchSettlements` stays a stub: the pilot
reconciles from the statement CSV through the existing `SettlementImport` port.

The mock adapter issues `VT_MOCK_…` with a fake NUBAN so the full flow is
exercisable without the network.

## Application changes

- **Provisioning** (`CollectorCashService.provisionCollectorDepositInstruction`):
  idempotent — an active instruction for the provider is returned rather than
  duplicated; rotating revokes the old one and provisions a new terminal;
  `deactivateCollectorDepositInstruction` revokes locally and calls the adapter.
- **Webhook** (`PaymentService.processEvent`): resolve the instruction by
  `event.attributionKey ?? event.providerReference`; pass the resolved row into
  `ingestDeposit` so the lookup cannot disagree with the destination.
- **Deposit** (`ingestDeposit`): under `prepaid`, post the credit unconditionally,
  mark the deposit `matched`, skip open-intake allocation, and write the
  over-cap audit. Under `postpaid`, keep today's allocation/suspense logic.
- **Intake**: replace `assertWithinCeiling` with `assertIntakeAllowed`, which
  understands the model; prepaid intakes are inserted `matched` (there is no
  deposit to wait for) so the deadline sweeper ignores them.
- **Wallet view**: add `model`, `availableMinor`, `intakeLimitMinor`,
  `maxBalanceMinor`, and the terminal details. `depositInstruction` keeps its
  `provider`, `reference`, `kind` and gains the optional display fields.
- **Audit**: provisioning and deactivation are audited with the terminal code,
  never the account name alone; the deposit path is audited by the existing
  webhook/deposit records.

## API and apps

- `POST /v1/cash/collectors/:collectorUserId/deposit-instruction` keeps its path
  and payload; the response adds the terminal details.
- `DELETE /v1/cash/collectors/:collectorUserId/deposit-instruction` deactivates.
- `GET /v1/cash/wallets/:collectorUserId` returns the extended view.
- Regenerate `packages/api-client` after the schemas change.
- **Collector app**: the existing Deposit screen becomes **Fund wallet** — the
  NUBAN with a copy button, account name, bank, the terminal page link when there
  is no NUBAN, the current credit and the maximum, and a 5-second refetch while
  the screen is open. The home screen's float bar uses `availableMinor` and
  explains the prepaid state ("Top up to start collecting").
- **Dashboard**: collector detail shows the terminal state, a provision/rotate
  action, top-up history and the over-cap flag. Deactivating a collector's
  account deactivates the terminal.

## PwT later

The port keeps `createDepositAttribution` as the only destination call. Adding
Pay with Transfer means:

1. a `cashRules.funding: "pay_with_transfer"` value and `topUpPresetsMinor`;
2. `createTopUpCharge` / `verifyCharge` on the port and the adapter;
3. a `collector_topups` table keyed by our `cw_…` reference;
4. a top-up screen that asks for an amount first.

Nothing in the ledger, the prepaid guard, the maximum balance or the apps' balance
display changes: a top-up is a credit either way.

## Tests and acceptance

- **Conformance**: both payment adapters pass the shared suite and a recorded
  fixture; the mock and Paystack normalise `attributionKey` identically.
- **Provisioning**: a terminal is created once; a second call returns it; rotation
  revokes the first code; deactivation revokes locally and remotely.
- **Webhook**: an attributed terminal deposit credits the wallet gross, once; a
  replay changes nothing; an unknown terminal is ignored and alerted; a
  cross-tenant terminal is ignored; a terminal for a deleted collector is
  ignored.
- **Prepaid**: an intake with no credit is refused with `insufficient_float`; a
  top-up unblocks it; the hard guard refuses the first unit over zero; grace
  permits exactly `graceMinor`; the maximum balance flags an over-cap top-up.
- **Postpaid regression**: the existing ceiling, suspense, deadline and freeze
  suites pass unchanged.
- **Property**: debits equal credits through the top-up/intake cycle.
- **App**: the collector flow shows "fund first" at zero and allows collection
  after a top-up; the deposit screen renders a NUBAN when present and a page link
  when absent.

## Risks

- **Terminal product limits** (per integration, or disabling the product) are the
  single biggest external risk; the PwT fallback is the answer and is designed in.
- **No NUBAN in Test Mode.** The app must not assume `accountNumber` exists.
- **Webhook-only confirmation.** There is no reference of ours to poll (the
  terminal's reference is Paystack's). Paystack retries for 72 hours; the pilot
  adds a daily transaction sweep as the safety net and keeps a manual "record a
  transfer" fallback on the dashboard.
- **Settlement float.** The wallet is credited on arrival while the State's bank
  balance moves on T+1. `GATEWAY_CLEARING` makes that gap visible; finance should
  watch it.
- **One terminal per collector** is a Paystack-dashboard object the State will see
  grow with the collector register; deactivating leavers is part of the runbook.

## Commit sequence

1. ADR 0069 and this plan.
2. Port, shared contract, mock adapter.
3. Live Paystack adapter with injected HTTP and fixtures.
4. Migration 0028, DB types and repositories.
5. Config schema, defaults and accessors; domain intake guard.
6. Application services: provisioning, webhook attribution, prepaid deposit and
   intake.
7. API routes, schemas, regenerated client.
8. Collector app and dashboard.
9. Runbook, seed, docs, metrics.
10. Format, lint, typecheck, tests, migration check.
